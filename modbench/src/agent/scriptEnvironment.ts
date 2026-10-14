import type * as vscode from 'vscode';

export const SCRIPT_ENVIRONMENT = {
  name: 'script_environment',
  description: "The environment variables a script needs to import medit and reach this window's mEdit. Set each in the shell that runs the script.",
  of: (terminalEnvironment: Pick<vscode.EnvironmentVariableCollection, 'forEach'>) => {
    const variables: Record<string, string> = {};
    terminalEnvironment.forEach((name, { value }) => { variables[name] = value; });
    return variables;
  },
};
