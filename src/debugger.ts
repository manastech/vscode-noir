import {
  debug,
  window,
  workspace,
  DebugAdapterDescriptorFactory,
  DebugSession,
  DebugAdapterExecutable,
  DebugAdapterDescriptor,
  ExtensionContext,
  OutputChannel,
  DebugConfigurationProvider,
  CancellationToken,
  DebugConfiguration,
  ProviderResult,
} from 'vscode';

import { spawn } from 'child_process';
import findNargo from './find-nargo';
import findNearestPackageFrom from './find-nearest-package';

let outputChannel: OutputChannel;

export function activateDebugger(context: ExtensionContext) {
  outputChannel = window.createOutputChannel('NoirDebugger');

  context.subscriptions.push(
    debug.registerDebugAdapterDescriptorFactory('noir', new NoirDebugAdapterDescriptorFactory()),
    debug.registerDebugConfigurationProvider('noir', new NoirDebugConfigurationProvider()),
    debug.onDidTerminateDebugSession(() => {
      outputChannel.appendLine("Debug session ended.");
    }),
  );
}

export class NoirDebugAdapterDescriptorFactory implements DebugAdapterDescriptorFactory {
  async createDebugAdapterDescriptor(
    _session: DebugSession,
    _executable: DebugAdapterExecutable,
  ): ProviderResult<DebugAdapterDescriptor> {
    const config = workspace.getConfiguration('noir');

    const configuredNargoPath = config.get<string | undefined>('nargoPath');
    const nargoPath = configuredNargoPath || findNargo();

    return new DebugAdapterExecutable(nargoPath, ['dap']);
  }
}

class NoirDebugConfigurationProvider implements DebugConfigurationProvider {
  async resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {
    if (config.program || config.request == 'attach')
      return config;

    if (window.activeTextEditor?.document.languageId != 'noir')
      return window.showInformationMessage("Select a Noir file to debug");

    const currentFilePath = window.activeTextEditor.document.uri.fsPath;
    let currentProjectFolder = findNearestPackageFrom(currentFilePath);

    const workspaceConfig = workspace.getConfiguration('noir');
    const nargoPath = workspaceConfig.get<string | undefined>('nargoPath') || findNargo();

    outputChannel.clear();
    outputChannel.appendLine(`Using nargo at ${nargoPath}`);
    outputChannel.appendLine("Compiling Noir project...");
    outputChannel.appendLine("");

    // Run Nargo's DAP in "pre-flight mode", which test runs
    // the DAP initialization code without actually starting the DAP server.
    // This lets us gracefully handle errors that happen *before*
    // the DAP loop is established, which otherwise are considered
    // "out of band".
    const preflightCheck = spawn(nargoPath, [
      'dap',
      '--preflight-check',
      '--preflight-project-folder',
      currentProjectFolder
    ]);

    // Create a promise to block until the preflight check child process
    // ends.
    let ready: (r: Boolean) => void;
    const preflightCheckMonitor = new Promise((resolve) => ready = resolve);

    preflightCheck.stderr.on('data', ev_buffer => preflightCheckPrinter(ev_buffer, outputChannel));
    preflightCheck.stdout.on('data', ev_buffer => preflightCheckPrinter(ev_buffer, outputChannel));
    preflightCheck.on('data', ev_buffer => preflightCheckPrinter(ev_buffer, outputChannel));
    preflightCheck.on('exit', async code => {
      if (code !== 0) {
        outputChannel.appendLine(`Exited with code ${code}`);
      }
      ready(code == 0);
    });

    if (!await preflightCheckMonitor) {
      outputChannel.show();
      throw new Error("Error launching debugger. Please inspect the Output pane for more details.");
    } else {
      outputChannel.appendLine("Starting debugger session...");
    }

    return {
      type: 'noir',
      name: 'Noir binary package',
      request: 'launch',
      program: currentFilePath,
      projectFolder: currentProjectFolder,
    }
  }
}

/**
 * Takes stderr or stdout output from the Nargo's DAP
 * preflight check and formats it in an Output pane friendly way,
 * by removing all special characters.
 *
 * Note: VS Code's output panes only support plain text.
 *
 */
function preflightCheckPrinter(buffer: Buffer, output: OutputChannel) {
  const formattedOutput = buffer.toString()
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
        .replace(/[^ -~\n\t]/g, '');

  output.appendLine(formattedOutput);
}