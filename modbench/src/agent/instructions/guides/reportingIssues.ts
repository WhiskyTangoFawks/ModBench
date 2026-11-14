export const REPORTING_ISSUES_GUIDE = `Modbench is your toolchain, and its issue tracker is upstream: github.com/WhiskyTangoFawks/ModBench. Report to it with gh, as you would against any open-source tool, and only once the user approves the issue's text.

- Do the job through Modbench's tools first. A job you did by hand, where a tool or a guide covers it, is no evidence that Modbench cannot do it.
- Search the open and closed issues first. A closed one may be fixed in a later build.
- A bug is Modbench doing other than a tool description or a guide says. Quote that sentence. Reproduce the bug on the running build, then report the steps, what you expected, what happened, and the build.
- Quote Modbench's reply word for word, or ask the user for the Modbench Output's lines when they ran the gesture. Name each record by its FormKey and EditorID, in its plugin. For a plugin from Nexus, name its mod and file, so the maintainer can download the same one; for the user's own plugin, include the plugin source that reproduces the bug.
- When no tool does a job, request an enhancement: name the job, and what you did by hand instead. First check that the job fits the workflows the guides describe, worked as a developer would: a job that is a file edit, or a series of tools a Modbench script can run, needs no tool of its own.
- Open the title with Bug: or Enhancement:. A label you set is dropped unless you can push to the repository.
- Pass the body with --body-file. In a quoted --body, the shell runs each backtick span as a command.`;
