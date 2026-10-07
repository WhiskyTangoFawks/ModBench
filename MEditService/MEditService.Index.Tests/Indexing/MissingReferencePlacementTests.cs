using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Indexing;

public sealed class MissingReferencePlacementTests : IDisposable
{
    private const string Referrer = "Referrer";

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("missing-ref-placement")
        .WithPlugin("Tracked.esp", mod => mod.Npcs.AddNew(Referrer).Race.SetTo(FormKey.Factory("000ABC:Absent.esp")), origin: "TrackedMod")
        .BuildScattered();

    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;
    private readonly LoadOrderEntry _tracked;

    public MissingReferencePlacementTests()
    {
        _tracked = _fixture.Plugins.Single();
        TrackedMods.Track(_tracked, _fixture.GameDirectory);
        _index = Indexes.Open(_holder);
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private IReadOnlyList<MissingReferenceOnFile> Placed(bool providedByMod = true) =>
        _index.RequireReads().GetReferencesToMissingRecordsOnFiles(
            _ => providedByMod ? new PluginProvider.FromMod(_tracked.Origin, _tracked.ModFolderOf()) : null);

    [Fact]
    public void ReportingMissingReferences_ATrackedReferrer_NamesItsDocumentRelativeToTheModFolder()
    {
        var placed = Assert.Single(Placed());

        Assert.Null(placed.Failure);
        Assert.Equal(
            _tracked.SourceFileOf(new RecordIdentity(placed.Reference.FormKey, placed.Reference.RecordType, Referrer)),
            Path.Combine(_tracked.ModFolderOf(), placed.SourceRelativePath ?? ""));
    }

    [Fact]
    public void ReportingMissingReferences_AReferrerWhoseDocumentWasDeletedOutsideModbench_IsAFailureNotAPath()
    {
        File.Delete(Path.Combine(_tracked.ModFolderOf(), Assert.Single(Placed()).SourceRelativePath ?? ""));

        var placed = Assert.Single(Placed());

        Assert.Null(placed.SourceRelativePath);
        Assert.Contains(placed.Reference.FormKey, placed.Failure, StringComparison.Ordinal);
    }

    [Fact]
    public void ReportingMissingReferences_APluginNoModFolderProvides_IsAFailure()
    {
        var placed = Assert.Single(Placed(providedByMod: false));

        Assert.Null(placed.SourceRelativePath);
        Assert.NotNull(placed.Failure);
    }
}
