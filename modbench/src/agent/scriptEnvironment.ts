export interface TerminalEnvironment {
  forEach(each: (name: string, mutator: { value: string }) => void): void;
}

export const SCRIPT_ENVIRONMENT = {
  name: 'script_environment',
  of: (terminalEnvironment: TerminalEnvironment) => {
    const variables: Record<string, string> = {};
    terminalEnvironment.forEach((name, { value }) => { variables[name] = value; });
    return variables;
  },
};
