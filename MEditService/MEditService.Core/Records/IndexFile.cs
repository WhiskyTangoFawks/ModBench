using System.Security.Cryptography;
using System.Text;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

/// <summary>
/// Where a game's index lives on disk (#585 / ADR-0001): <b>one DuckDB file per game Data
/// install</b>, under the service's own local app data, shared by every MO2 instance and every
/// profile pointed at that install — which is what makes the vanilla masters indexed once, ever,
/// rather than once per profile.
///
/// <para>Keyed by the Data folder rather than by the game release alone, because two installs of
/// one game (a Steam copy and a GOG copy, a modding sandbox beside the played install) are two
/// different sets of files and must not share one mirror. The release is still in the file name,
/// for a human reading the directory.</para>
///
/// <para><b>Never inside a mod folder or the game directory.</b> Those are owned by MO2, the
/// installers and the user (root CLAUDE.md's never-assume-exclusive-ownership rule); an index
/// written there would be swept away by a mod reinstall or picked up by a mod archiver as content.
/// Local app data is per-machine, which is also the right scope: the index is derived state whose
/// only cost of loss is one cold load.</para>
/// </summary>
public static class IndexFile
{
    /// <summary>
    /// <c>%LOCALAPPDATA%/mEdit</c> — the same root the service already writes its logs under
    /// (<c>Program.cs</c>). The composition root passes this to
    /// <see cref="DuckDbRecordIndexFactory"/>; tests pass a temp directory instead, which is the
    /// whole reason it is a parameter rather than read from the environment down here.
    /// </summary>
    public static string DefaultRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "mEdit");

    /// <summary>The index file for one game Data install under <paramref name="root"/>. Pure — it
    /// creates nothing; <see cref="DuckDbRecordIndex"/> creates the directory when it opens.</summary>
    public static string PathFor(string root, GameRelease release, string dataFolderPath)
    {
        var canonical = Path.TrimEndingDirectorySeparator(Path.GetFullPath(dataFolderPath));
        // Case-folded only where the file system is: two paths differing in case are one directory
        // on Windows and two different directories everywhere else, and the key has to say the same.
        var keyed = OperatingSystem.IsWindows() ? canonical.ToUpperInvariant() : canonical;
        var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(keyed)))[..16];
        return Path.Combine(root, "index", $"{release}-{digest}.duckdb");
    }
}
