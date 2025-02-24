import {
  workspace,
  WorkspaceFolder,
  Uri,
  window,
  tests,
  TestRunProfileKind,
  Range,
  TestItem,
  TestMessage,
  TestController,
  OutputChannel,
  CancellationToken,
  TestRunRequest,
} from 'vscode';

import {
  LanguageClient,
  LanguageClientOptions,
  ServerCapabilities,
  ServerOptions,
  TextDocumentFilter,
} from 'vscode-languageclient/node';

import { extensionName, languageId } from './constants';
import { getNargoPath } from './find-nargo';

type NargoCapabilities = {
  nargo?: {
    tests?: {
      fetch: boolean;
      run: boolean;
      update: boolean;
    };
  };
};

type NargoTests = {
  package: string;
  uri: string;
  tests?: {
    id: string;
    label: string;
    uri: string;
    range: Range;
  }[];
};

export type FileId = number;
export type FileInfo = {
  path: string;
  source: string;
};

export type Span = {
  start: number;
  end: number;
};
export type SpanInFile = {
  file: FileId;
  span: Span;
};
export type OpcodesCounts = {
  acir_size: number;
  brillig_size: number;
};

export type NargoProfileRunResult = {
  file_map: Map<FileId, FileInfo>;
  opcodes_counts: [[SpanInFile, OpcodesCounts]];
};

type RunTestResult = {
  id: string;
  result: 'pass' | 'fail' | 'error';
  message: string;
};

function globFromUri(uri: Uri, glob: string) {
  // globs always need to use `/`
  return `${uri.fsPath}${glob}`.replaceAll('\\', '/');
}

function getLspCommand(uri: Uri) {
  const config = workspace.getConfiguration('noir', uri);

  const lspEnabled = config.get<boolean>('enableLSP');

  if (!lspEnabled) {
    return;
  }

  const command = getNargoPath(uri);

  const flags = config.get<string | undefined>('nargoFlags') || '';

  // Remove empty strings from the flags list
  const args = ['lsp', ...flags.split(' ')].filter((arg) => arg !== '');

  return [command, args] as const;
}

export default class Client extends LanguageClient {
  #uri: Uri;
  #command: string;
  #args: string[];
  #output: OutputChannel;
  profileRunResult: NargoProfileRunResult;
  // This function wasn't added until vscode 1.81.0 so fake the type
  #testController: TestController & {
    invalidateTestResults?: (item: TestItem) => void;
  };

  constructor(uri: Uri, workspaceFolder?: WorkspaceFolder) {
    const outputChannel = window.createOutputChannel(extensionName, languageId);

    const [command, args] = getLspCommand(uri);

    const documentSelector: TextDocumentFilter[] = [];
    if (workspaceFolder) {
      documentSelector.push({
        scheme: 'file',
        language: languageId,
        // Glob starts with `/` because it just appends both segments
        pattern: `${globFromUri(uri, '/**/*')}`,
      });
    } else {
      documentSelector.push({
        scheme: uri.scheme,
        language: languageId,
        pattern: `${globFromUri(uri, '')}`,
      });
    }

    const config = workspace.getConfiguration('noir', uri);

    const enableCodeLens = config.get<boolean>('enableCodeLens');

    const clientOptions: LanguageClientOptions = {
      documentSelector,
      workspaceFolder,
      outputChannel,
      initializationOptions: {
        enableCodeLens,
      },
    };

    const serverOptions: ServerOptions = {
      command,
      args,
    };

    super(languageId, extensionName, serverOptions, clientOptions);

    this.#uri = uri;
    this.#command = command;
    this.#args = args;
    this.#output = outputChannel;

    // TODO: Figure out how to do type-safe onNotification
    this.onNotification('nargo/tests/update', (testData: NargoTests) => {
      this.#updateTests(testData);
    });

    this.registerFeature({
      fillClientCapabilities: () => {},
      initialize: (capabilities: ServerCapabilities & NargoCapabilities) => {
        if (typeof capabilities.nargo?.tests !== 'undefined') {
          this.#testController = tests.createTestController(
            // We prefix with our ID namespace but we also tie these to the URI since they need to be unique
            `NoirWorkspaceTests-${uri.toString()}`,
            'Noir Workspace Tests',
          );

          if (capabilities.nargo.tests.fetch) {
            // TODO: reload a single test if provided as the function argument
            this.#testController.resolveHandler = async (_test) => {
              await this.#fetchTests();
            };
            this.#testController.refreshHandler = async (token) => {
              await this.#refreshTests(token);
            };
          }

          if (capabilities.nargo.tests.run) {
            this.#testController.createRunProfile(
              'Run Tests',
              TestRunProfileKind.Run,
              async (request, token) => {
                await this.#runTest(request, token);
              },
              true,
            );
          }
        }
      },
      getState: () => {
        return { kind: 'static' };
      },
      dispose: () => {
        if (this.#testController) {
          this.#testController.dispose();
        }
      },
    });
  }

  get command(): string {
    return this.#command;
  }

  async refreshProfileInfo() {
    const response = await this.sendRequest<NargoProfileRunResult>('nargo/profile/run', { package: '' });

    this.profileRunResult = response;
  }

  async #fetchTests() {
    const response = await this.sendRequest<NargoTests[]>('nargo/tests', {});

    response.forEach((testData) => {
      this.#createTests(testData);
    });
  }

  async #refreshTests(token: CancellationToken) {
    const response = await this.sendRequest<NargoTests[]>('nargo/tests', {}, token);
    response.forEach((testData) => {
      this.#updateTests(testData);
    });
  }

  async #runTest(request: TestRunRequest, token: CancellationToken) {
    const run = this.#testController.createTestRun(request);
    const queue: TestItem[] = [];

    // Loop through all included tests, or all known tests, and add them to our queue
    if (request.include) {
      request.include.forEach((test) => queue.push(test));
    } else {
      this.#testController.items.forEach((test) => queue.push(test));
    }

    while (queue.length > 0 && !token.isCancellationRequested) {
      const test = queue.pop()!;

      // Skip tests the user asked to exclude
      if (request.exclude?.includes(test)) {
        continue;
      }

      // We don't run our test headers since they are just for grouping
      // but this is fine because the test pass/fail icons are propagated upward
      if (test.parent) {
        // If we have these tests, the server will be able to run them with this message
        const {
          id: _,
          result,
          message,
        } = await this.sendRequest<RunTestResult>(
          'nargo/tests/run',
          {
            id: test.id,
          },
          token,
        );

        // TODO: Handle `test.id !== id`. I'm not sure if it is possible for this to happen in normal usage

        if (result === 'pass') {
          run.passed(test);
          continue;
        }

        if (result === 'fail' || result === 'error') {
          run.failed(test, new TestMessage(message));
          continue;
        }
      }

      // After tests are run (if any), we add any children to the queue
      test.children.forEach((test) => queue.push(test));
    }

    run.end();
  }

  #createTests(testData: NargoTests) {
    const pkg = this.#testController.createTestItem(testData.package, testData.package);

    testData.tests.forEach((test) => {
      const item = this.#testController.createTestItem(test.id, test.label, Uri.parse(test.uri));
      item.range = test.range;
      pkg.children.add(item);
    });

    this.#testController.items.add(pkg);
  }

  #updateTests(testData: NargoTests) {
    // This function wasn't added until vscode 1.81.0 so we check for it
    if (typeof this.#testController.invalidateTestResults === 'function') {
      const pkg = this.#testController.items.get(testData.package);
      this.#testController.invalidateTestResults(pkg);
    }

    this.#createTests(testData);
  }

  async start(): Promise<void> {
    await super.start();
  }

  async dispose(timeout?: number): Promise<void> {
    await super.dispose(timeout);
  }
}
