using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// <see cref="SourceUnitResolver.RenormalizeGroupOrder"/> in isolation — the algorithm a
/// structural write (<c>RecordEditService.DeleteRecord</c>/<c>RenumberRecord</c>/<c>CreateRecord</c>)
/// calls as its own last file-system act to close whatever <c>"[N]"</c> gap it left, so
/// <c>PluginCompileService</c>'s byte-exact round-trip gate never refuses a plugin whose
/// only sin is a benign numbering gap.
///
/// <para>Tested directly against a synthetic directory rather than only through the full
/// Track/Edit/Compile pipeline — the same posture <c>SourceRecordPathTests</c> already takes with its
/// sibling class. The one property that genuinely needs it: whether the sort key is the parsed integer
/// or the filename text, which only diverges once a group holds a two-digit index (<c>"[10]"</c> sorts
/// before <c>"[5]"</c> as text) — cheap to build directly here, expensive through ten-plus real
/// tracked siblings.</para>
/// </summary>
public sealed class SourceUnitResolverRenormalizeGroupOrderTests : IDisposable
{
    private readonly string _groupDirectory = Directory.CreateTempSubdirectory("medit-renormalize-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_groupDirectory, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }

    private string WriteFile(string leafName)
    {
        var path = Path.Combine(_groupDirectory, leafName);
        File.WriteAllText(path, leafName);
        return path;
    }

    [Fact]
    public void NoGaps_RenamesNothing()
    {
        WriteFile("[0] Alpha - 000001_Fixture.esp.json");
        WriteFile("[1] Beta - 000002_Fixture.esp.json");

        SourceUnitResolver.RenormalizeGroupOrder(_groupDirectory);

        Assert.True(File.Exists(Path.Combine(_groupDirectory, "[0] Alpha - 000001_Fixture.esp.json")));
        Assert.True(File.Exists(Path.Combine(_groupDirectory, "[1] Beta - 000002_Fixture.esp.json")));
    }

    [Fact]
    public void AGap_ClosesToContiguous_PreservingRelativeOrderAndContent()
    {
        // [0],[2],[5] — two gaps (1 and 3-4), the shape a delete leaves behind.
        WriteFile("[0] Alpha - 000001_Fixture.esp.json");
        WriteFile("[2] Beta - 000002_Fixture.esp.json");
        WriteFile("[5] Gamma - 000003_Fixture.esp.json");

        SourceUnitResolver.RenormalizeGroupOrder(_groupDirectory);

        var names = Directory.GetFiles(_groupDirectory).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList();
        Assert.Equal(3, names.Count);
        Assert.Contains("[0] Alpha - 000001_Fixture.esp.json", names);
        Assert.Contains("[1] Beta - 000002_Fixture.esp.json", names);
        Assert.Contains("[2] Gamma - 000003_Fixture.esp.json", names);

        // Content travels with the rename — this is a rename, not a rewrite.
        Assert.Equal(
            "[2] Beta - 000002_Fixture.esp.json",
            File.ReadAllText(Path.Combine(_groupDirectory, "[1] Beta - 000002_Fixture.esp.json")));
    }

    /// <summary>
    /// The rival this test exists to catch: sorting survivors by filename <i>text</i> instead of the
    /// parsed <c>"[N]"</c> integer. <c>"[10]"</c> sorts before <c>"[5]"</c> as text (the character '1'
    /// precedes '5'), so a text-sorted renormalization would rank Ten ahead of Five — scrambling two
    /// records that were never touched by whatever left the gap between them.
    /// </summary>
    [Fact]
    public void DoubleDigitIndices_SortNumerically_NotAlphabetically()
    {
        WriteFile("[0] Zero - 000000_Fixture.esp.json");
        WriteFile("[5] Five - 000005_Fixture.esp.json");
        WriteFile("[10] Ten - 000010_Fixture.esp.json");

        SourceUnitResolver.RenormalizeGroupOrder(_groupDirectory);

        var names = Directory.GetFiles(_groupDirectory).Select(Path.GetFileName).ToList();
        Assert.Contains("[0] Zero - 000000_Fixture.esp.json", names);
        // Five (old index 5) must land at new index 1, ahead of Ten (old index 10) at new index 2 —
        // the numeric order, not the '"[10]" < "[5]"' text order.
        Assert.Contains("[1] Five - 000005_Fixture.esp.json", names);
        Assert.Contains("[2] Ten - 000010_Fixture.esp.json", names);
    }

    [Fact]
    public void DirectoryPerRecordSiblings_AreMovedWhole_NotJustRenamed()
    {
        var first = Directory.CreateDirectory(Path.Combine(_groupDirectory, "[0] CellA - 000001_Fixture.esp")).FullName;
        File.WriteAllText(Path.Combine(first, SourceUnitResolver.RecordDataFileName), "CellA-content");
        var second = Directory.CreateDirectory(Path.Combine(_groupDirectory, "[3] CellB - 000002_Fixture.esp")).FullName;
        File.WriteAllText(Path.Combine(second, SourceUnitResolver.RecordDataFileName), "CellB-content");

        SourceUnitResolver.RenormalizeGroupOrder(_groupDirectory);

        var newSecond = Path.Combine(_groupDirectory, "[1] CellB - 000002_Fixture.esp");
        Assert.True(Directory.Exists(newSecond));
        Assert.Equal("CellB-content", File.ReadAllText(Path.Combine(newSecond, SourceUnitResolver.RecordDataFileName)));
    }

    [Fact]
    public void MissingDirectory_DoesNotThrow()
    {
        var missing = Path.Combine(_groupDirectory, "does-not-exist");

        var exception = Record.Exception(() => SourceUnitResolver.RenormalizeGroupOrder(missing));
        Assert.Null(exception);
    }
}
