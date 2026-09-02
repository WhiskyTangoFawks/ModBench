using System.Security.Cryptography;

namespace MEditService.Tests.TestSupport;

/// <summary>
/// "Is this working tree byte-identical to what it was?" answered directly off the filesystem: the
/// full set of paths, every file's content hash, and — the half no git-based oracle can answer —
/// every directory, empty ones included.
///
/// <para><b>Why it exists next to <c>git status</c> rather than instead of it.</b> Git tracks files,
/// not directories, so a stray empty record directory is invisible to <c>status</c> while being
/// exactly the debris #675 was about: it occupies an ordering slot and fails the next whole-plugin
/// ingest. A rollback test that used only the repository's own status as its oracle would report
/// clean over precisely that damage. The two are used together and the disagreement is demonstrated
/// (<c>RenumberRollbackTests.TheDirectFilesystemOracleSeesAnEmptyDirectory_WhichGitStatusCallsClean</c>),
/// so neither is taken on faith.</para>
///
/// <para><c>.git</c> is excluded: it is the repository's own bookkeeping, it changes for reasons that
/// have nothing to do with the working tree (index mtimes, logs), and it is not what "the author's
/// working tree" means.</para>
/// </summary>
internal static class TreeSnapshot
{
    /// <summary>One line per entry, sorted, relative to <paramref name="root"/> and slash-normalized:
    /// <c>dir &lt;path&gt;</c> for a directory, <c>file &lt;path&gt; &lt;sha256&gt;</c> for a file.
    /// Comparing two of these with <c>Assert.Equal</c> names the first differing line, which is what
    /// makes a failure readable.</summary>
    internal static IReadOnlyList<string> Of(string root)
    {
        var lines = new List<string>();
        foreach (var entry in Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(root, entry).Replace('\\', '/');
            if (relative == ".git" || relative.StartsWith(".git/", StringComparison.Ordinal)) continue;

            lines.Add(Directory.Exists(entry)
                ? $"dir  {relative}"
                : $"file {relative} {Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(entry)))}");
        }

        lines.Sort(StringComparer.Ordinal);
        return lines;
    }
}
