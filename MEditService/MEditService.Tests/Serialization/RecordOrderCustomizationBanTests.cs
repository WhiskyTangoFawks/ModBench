namespace MEditService.Tests.Serialization;

/// <summary>
/// <c>.EnforceRecordOrder()</c> must never come back (ADR-0042 decision 4, as amended by #566). Order
/// is carried in the parent's own ordered child list; turning the serialization library's filename
/// numbering back on would put a second, contradicting carrier in the tree — and the two would
/// disagree silently, because a numbered name still deserializes fine.
///
/// <para><b>Why a source-text ban rather than trusting one deleted line.</b> The flag is set per
/// generator compilation, and one compilation can seed exactly one game — so a codebase that grows a
/// second game grows a second customization class to set it in, and a third game a third. "Delete it
/// in one place" stops being true the moment the backend is multi-game, which is live work on another
/// branch right now. The author of a new game's seed will copy an existing one; this is what tells
/// them, immediately, that the copied line is not wanted.</para>
///
/// <para><b>Production sources only, deliberately.</b> Test files legitimately name the flag in prose
/// while explaining the numbering they used to assert, and a ban that caught comments would fire on
/// those instead of on the thing that matters.</para>
/// </summary>
public sealed class RecordOrderCustomizationBanTests
{
    [Fact]
    public void NoProductionSource_CallsEnforceRecordOrder()
    {
        var root = RepositoryRoot();
        var offenders = Directory
            .EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(IsProductionSource)
            .Where(file => File.ReadAllText(file).Contains(".EnforceRecordOrder(", StringComparison.Ordinal))
            .Select(file => Path.GetRelativePath(root, file))
            .ToList();

        Assert.True(
            offenders.Count == 0,
            $"Order is carried in the parent's ordered child list (ADR-0042 decision 4), not in file " +
            $"names. Remove the .EnforceRecordOrder() call in: {string.Join(", ", offenders)}");
    }

    /// <summary>Guards the guard: a scan that silently matched nothing — a wrong root, a changed
    /// layout — would pass the ban forever while checking nothing at all.</summary>
    [Fact]
    public void TheScan_ActuallyReachesTheCustomizationItGuards()
    {
        var root = RepositoryRoot();
        var scanned = Directory
            .EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(IsProductionSource)
            .Select(Path.GetFileName)
            .ToList();

        Assert.Contains("RecordTextCodecCustomization.cs", scanned, StringComparer.Ordinal);
    }

    private static bool IsProductionSource(string file)
    {
        var segments = file.Split(Path.DirectorySeparatorChar);
        return !segments.Contains("obj", StringComparer.Ordinal)
            && !segments.Contains("bin", StringComparer.Ordinal)
            && !segments.Any(s => s.EndsWith(".Tests", StringComparison.Ordinal));
    }

    /// <summary>The <c>MEditService/</c> solution directory, walked up from the test assembly rather
    /// than hardcoded, so this keeps working from any build output layout.</summary>
    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "MEditService.sln"))) return directory.FullName;
        }

        throw new InvalidOperationException(
            "Could not find MEditService.sln above the test assembly — this guard cannot scan what it cannot locate.");
    }
}
