using System.Security.Cryptography;

namespace MEditService.Core.Source;

/// <summary>
/// The content hash of a plugin binary on disk — ADR-0001's "validity is by content, never by
/// clock", written once. Two callers depend on producing the *same* string for the same bytes and
/// would be silently broken by drifting apart: the index stamps a file's hash beside the rows it
/// built from it, and the runtime mirror compares a settled file against that same stamp to
/// tell a real change from a touch. They live in different assemblies — <c>Core.Records</c>
/// and <c>MEditService.Bridge</c>, which may not see each other — so this sits in the one namespace
/// both are allowed to reference.
/// </summary>
public static class PluginBinaryHash
{
    /// <summary>
    /// Streams the file rather than reading it whole: the largest plugin in a real load order is the
    /// game's own master at hundreds of megabytes, and this runs once per indexed file at every
    /// index open.
    ///
    /// <para>Returns <see langword="null"/> when the file cannot be read at all — another process
    /// mid-write, or permissions that changed under us. That is deliberately <i>not</i> an
    /// exception and deliberately not "unchanged": an unreadable file is no evidence either way,
    /// and each caller says what it does about that (the index treats it as a mismatch and drops
    /// the rows; the watcher waits for the next event). This is a leaf helper with no logger of its
    /// own by design — the callers log, in their own vocabulary.</para>
    /// </summary>
    public static string? OfFile(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            return Convert.ToHexStringLower(SHA256.HashData(stream));
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }
}
