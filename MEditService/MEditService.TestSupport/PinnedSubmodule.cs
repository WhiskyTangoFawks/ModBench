namespace MEditService.TestSupport;

/// <summary>An instance repository that pins a submodule at <c>source/&lt;name&gt;</c>, checked out nowhere, as a clone of
/// the instance repository leaves it, and the submodule's remote, made by its first commit.</summary>
public sealed class PinnedSubmodule
{
    // git refuses a submodule a remote on this machine unless protocol.file.allow says so, and a test's remotes are here.
    static PinnedSubmodule()
    {
        var count = int.TryParse(Environment.GetEnvironmentVariable("GIT_CONFIG_COUNT"), out var held) ? held : 0;
        Environment.SetEnvironmentVariable($"GIT_CONFIG_KEY_{count}", "protocol.file.allow");
        Environment.SetEnvironmentVariable($"GIT_CONFIG_VALUE_{count}", "always");
        Environment.SetEnvironmentVariable("GIT_CONFIG_COUNT", (count + 1).ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    public PinnedSubmodule(string root, string name = "Mod")
    {
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
}
