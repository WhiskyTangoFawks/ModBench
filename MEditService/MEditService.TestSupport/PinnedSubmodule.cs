namespace MEditService.TestSupport;

/// <summary>An instance repository that pins a submodule at <c>source/&lt;name&gt;</c>, checked out nowhere, and the
/// submodule's remote. A class that makes one runs in its assembly's process environment collection.</summary>
public sealed class PinnedSubmodule : IDisposable
{
    private readonly (string Variable, string? Was)[] _environment;

    // git refuses a submodule a remote on this machine unless protocol.file.allow says so, and the Source adapter's git
    // reads it from the process's environment alone, until this is disposed.
    public PinnedSubmodule(string root, string name = "Mod")
    {
        var count = int.TryParse(Environment.GetEnvironmentVariable("GIT_CONFIG_COUNT"), out var held) ? held : 0;
        (string Variable, string Value)[] allowing =
        [
            ($"GIT_CONFIG_KEY_{count}", "protocol.file.allow"), ($"GIT_CONFIG_VALUE_{count}", "always"),
            ("GIT_CONFIG_COUNT", (count + 1).ToString(System.Globalization.CultureInfo.InvariantCulture)),
        ];
        _environment = [.. allowing.Select(set => (set.Variable, Environment.GetEnvironmentVariable(set.Variable)))];
        foreach (var (variable, value) in allowing) Environment.SetEnvironmentVariable(variable, value);

        Name = name;
        Remote = Directory.CreateDirectory(Path.Combine(root, "remote")).FullName;
        Instance = Directory.CreateDirectory(Path.Combine(root, "instance")).FullName;
        Folder = Path.Combine(Instance, "source", name);
        Git(Instance, "init", "-q", "-b", "main");
        Git(Instance, "config", "-f", ".gitmodules", $"submodule.{name}.path", $"source/{name}");
        Git(Instance, "config", "-f", ".gitmodules", $"submodule.{name}.url", Remote);
    }

    public string Name { get; }

    public string Remote { get; }

    public string Instance { get; }

    /// <summary>Where git checks the submodule out.</summary>
    public string Folder { get; }

    /// <summary>Commits <paramref name="files"/>, by their path, to the remote's branch at HEAD, and answers the commit.</summary>
    public string Commit(params (string Path, string Text)[] files)
    {
        if (!Directory.Exists(Path.Combine(Remote, ".git"))) Git(Remote, "init", "-q", "-b", "main");
        foreach (var (path, text) in files)
        {
            var at = Path.Combine(Remote, path);
            Directory.CreateDirectory(Path.GetDirectoryName(at) ?? Remote);
            File.WriteAllText(at, text);
        }
        Git(Remote, "add", "-A");
        Git(Remote, "commit", "-q", "--allow-empty", "-m", "commit");
        return Git(Remote, "rev-parse", "HEAD").Trim();
    }

    /// <summary>The instance repository pins <paramref name="commit"/> in its index.</summary>
    public void Pin(string commit) => Git(Instance, "update-index", "--add", "--cacheinfo", $"160000,{commit},source/{Name}");

    /// <summary>The branch the submodule follows, none until <see cref="Follow"/>.</summary>
    public string? Branch { get; private set; }

    public void Follow(string branch)
    {
        Git(Instance, "config", "-f", ".gitmodules", $"submodule.{Name}.branch", branch);
        Branch = branch;
    }

    public static string Git(string folder, params string[] args) => GitProbe.Run(Path.Combine(folder, ".git"), folder, args);

    public void Dispose()
    {
        foreach (var (variable, was) in _environment) Environment.SetEnvironmentVariable(variable, was);
    }
}
