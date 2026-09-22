using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A link to a record embedded in another plugin's container: a container's child is a
/// record of the binary, so the link cache names it and compile must not call the link broken.</summary>
public sealed class CompileEmbeddedTargetTests : IDisposable
{
    private const string TargetName = "EmbeddedTarget.esp";
    private const string TargetOrigin = "EmbeddedTargetMod";
    private const string ReferrerName = "EmbeddedReferrer.esp";
    private const string ReferrerOrigin = "EmbeddedReferrerMod";

    private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-embedded-target-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-embedded-target-game-").FullName;
    private readonly string _targetFolder;
    private readonly string _referrerFolder;
    private readonly LoadOrderSnapshot _loadOrder;
    private readonly PluginCopyKey _referrer = new(ReferrerName, ReferrerOrigin);
    private readonly string _targetPath;
    private readonly string _referrerPath;
    private readonly FormKey _embeddedTarget;

    public CompileEmbeddedTargetTests()
    {
        _targetFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", TargetOrigin)).FullName;
        _referrerFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", ReferrerOrigin)).FullName;

        _targetPath = Path.Combine(_targetFolder, TargetName);
        var target = new Fallout4Mod(ModKey.FromFileName(TargetName), Fallout4Release.Fallout4);
        var targetCell = new Cell(target) { EditorID = "TargetCell" };
        var embedded = new PlacedObject(target) { EditorID = "EmbeddedRef", Position = new P3Float(1f, 1f, 1f) };
        targetCell.Temporary.Add(embedded);
        AddCell(target, targetCell);
        target.WriteToBinary(_targetPath);
        _embeddedTarget = embedded.FormKey;

        _referrerPath = Path.Combine(_referrerFolder, ReferrerName);
        var referrer = new Fallout4Mod(ModKey.FromFileName(ReferrerName), Fallout4Release.Fallout4);
        var referrerCell = new Cell(referrer) { EditorID = "ReferrerCell" };
        var pointer = new PlacedObject(referrer) { EditorID = "Pointer", Position = new P3Float(2f, 2f, 2f) };
        pointer.EnableParent = new EnableParent();
        pointer.EnableParent.Reference.SetTo(_embeddedTarget);
        referrerCell.Temporary.Add(pointer);
        AddCell(referrer, referrerCell);
        referrer.WriteToBinary(_referrerPath, new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
        {
            MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.Iterate,
        });

        _loadOrder = new LoadOrderSnapshot(
            _gameDirectory, _instanceRoot, GameRelease.Fallout4,
            SnapshotCopies.Of([
                Target(enabled: true),
                Referrer,
            ]));

        var trackService = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen());
        trackService.TrackAsync(_loadOrder, TargetOrigin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
        trackService.TrackAsync(_loadOrder, ReferrerOrigin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    private LoadOrderEntry Target(bool enabled) =>
        new(TargetName, _targetPath, TargetOrigin, Slot: 0, Enabled: enabled, Winning: true);

    private LoadOrderEntry Referrer =>
        new(ReferrerName, _referrerPath, ReferrerOrigin, Slot: 1, Enabled: true, Winning: true);

    private static void AddCell(Fallout4Mod mod, Cell cell)
    {
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }

    public void Dispose()
    {
        TryDelete(_instanceRoot);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }

    // The target's own file carries the record and the link cache names it from there, so a
    // "could not be resolved" diagnostic would be false.
    [Fact]
    public async Task Compile_ForALinkToARecordEmbeddedInAnotherTrackedPlugin_ReportsNothingAboutIt()
    {
        var result = await CompileServices.Over(_loadOrder).CompileAsync(_referrer, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.DoesNotContain(
            result.Diagnostics, d => d.Message.Contains(_embeddedTarget.ToString(), StringComparison.Ordinal));
    }

    // ADR-0013: a registered copy the game does not load is not where the link points, so its file
    // carrying the record proves nothing and the link is dangling like any other.
    [Fact]
    public async Task Compile_ForALinkIntoATrackedCopyTheLoadOrderDoesNotLoad_ReportsItUnresolved()
    {
        var notLoaded = new LoadOrderSnapshot(
            _gameDirectory, _instanceRoot, GameRelease.Fallout4, SnapshotCopies.Of([Target(enabled: false), Referrer]));

        var result = await CompileServices.Over(notLoaded).CompileAsync(_referrer, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.Contains(
            result.Diagnostics,
            d => d.Message.Contains($"[{_embeddedTarget}] <Error: Could not be resolved>", StringComparison.Ordinal));
    }

    // The same load order, asked the way compile asks: the silence above is the link resolving, not
    // a record nothing can name.
    [Fact]
    public void TheTargetsFile_CarriesTheEmbeddedRecord_AndTheLinkCacheNamesIt()
    {
        var targets = TestAdapters.Mutagen().LinkTargets(
            _loadOrder,
            _loadOrder.Copy(_referrer).Require(),
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4),
            [_embeddedTarget.ToString()]);

        Assert.Empty(targets.UnreadableFiles);
        Assert.Equal(new ResolvedFormKey("refr", "EmbeddedRef"), targets.Targets[_embeddedTarget.ToString()]);
    }
}
