namespace MEditService.SourceAdapter.Tests.TestSupport;

/// <summary>A setting the user's git config holds, given to every git this process starts while <c>body</c> runs. A test
/// using it joins <see cref="ProcessEnvironmentCollection"/>.</summary>
internal static class UserGitConfig
{
    internal static void With(string key, string value, Action body)
    {
        var count = int.TryParse(Environment.GetEnvironmentVariable("GIT_CONFIG_COUNT"), out var held) ? held : 0;
        string[] variables = ["GIT_CONFIG_COUNT", $"GIT_CONFIG_KEY_{count}", $"GIT_CONFIG_VALUE_{count}"];
        var previous = variables.Select(Environment.GetEnvironmentVariable).ToArray();
        try
        {
            Environment.SetEnvironmentVariable(variables[0], $"{count + 1}");
            Environment.SetEnvironmentVariable(variables[1], key);
            Environment.SetEnvironmentVariable(variables[2], value);
            body();
        }
        finally
        {
            foreach (var (variable, was) in variables.Zip(previous)) Environment.SetEnvironmentVariable(variable, was);
        }
    }
}
