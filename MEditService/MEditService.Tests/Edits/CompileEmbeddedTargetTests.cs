using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>debt #779: the link resolver reads a tracked tree by document name, so it cannot name a
/// record inside its container's document. Compile says nothing about a link to one rather than
/// calling it broken.</summary>
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
    private readonly LoadOrder _loadOrder;
    private readonly PluginKey _referrer = new(ReferrerName, ReferrerOrigin);
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

        _loadOrder = LoadOrder.From(
            _gameDirectory, _instanceRoot, GameRelease.Fallout4,
            [
                Target(enabled: true),
                Referrer,
            ]);

        var trackService = new TrackService(NullLogger<TrackService>.Instance);
        trackService.TrackAsync(_loadOrder, [new PluginKey(TargetName, TargetOrigin)], TargetOrigin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
        trackService.TrackAsync(_loadOrder, [_referrer], ReferrerOrigin, SourcePreset.Edits)
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

    // The target's own tree carries the record, so "could not be resolved" would be false — the
    // resolver's silence is a gap in what it can name, not a fact about the link.
    [Fact]
    public void Compile_ForALinkToARecordEmbeddedInAnotherTrackedPlugin_ReportsNothingAboutIt()
    {
        var result = CompileServices.Over(_loadOrder).Compile(_referrer, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.DoesNotContain(
            result.Diagnostics, d => d.Message.Contains(_embeddedTarget.ToString(), StringComparison.Ordinal));
    }

    // ADR-0044: a registered copy the game does not load is not where the link points, so its tree
    // carrying the record proves nothing and the link is dangling like any other.
    [Fact]
    public void Compile_ForALinkIntoATrackedCopyTheLoadOrderDoesNotLoad_ReportsItUnresolved()
    {
        var notLoaded = LoadOrder.From(
            _gameDirectory, _instanceRoot, GameRelease.Fallout4, [Target(enabled: false), Referrer]);

        var result = CompileServices.Over(notLoaded).Compile(_referrer, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.Contains(
            result.Diagnostics,
            d => d.Message.Contains($"[{_embeddedTarget}] <Error: Could not be resolved>", StringComparison.Ordinal));
    }

    // The same tree, asked the way the resolver asks: proof the silence above is the gap and not an
    // absent record.
    [Fact]
    public void TheTargetsTree_CarriesTheEmbeddedRecord_ThoughItsNameDoesNot()
    {
        var target = new PluginKey(TargetName, TargetOrigin);
        var repository = SourceRepository.Open(_targetFolder, GameRelease.Fallout4)!;

        Assert.True(repository.CarriesEmbedded(target, _embeddedTarget.ToString()));
        using var resolver = new FormLinkResolver(_loadOrder, new DefaultModImporter(), SharedSchemaReflector.Instance);
        Assert.Null(resolver.Resolve(_embeddedTarget.ToString()));
    }
}
