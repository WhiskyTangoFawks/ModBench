using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Changes;

// Phase 16.2.1 — copy-as-override and delete of placed refs (REFR) that live inside a master cell.
// Builds on the proven create spike (PluginWriterPlacedSpikeTests): exercises the two new
// cell-aware writer branches. Both pull the parent cell into the active plugin as an override via
// the reflection-driven link-cache path, then add/remove the placed ref in its Persistent list.
public class PluginWriterPlacedTests
{
    private static readonly ISchemaReflector _reflector = new SchemaReflector();

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private sealed class PlacedFixture : IDisposable
    {
        public required PluginFixtureData Data { get; init; }
        public required IModGetter MasterGetter { get; init; }
        public required IModGetter ActiveGetter { get; init; }
        public required ILinkCache LinkCache { get; init; }
        public required string ActivePath { get; init; }
        public required ModKey ActiveModKey { get; init; }
        public required FormKey CellFk { get; init; }
        public required FormKey RefAFk { get; init; }
        public required FormKey RefBFk { get; init; }
        public required FormKey RefABase { get; init; }

        public void Dispose()
        {
            (MasterGetter as IDisposable)?.Dispose();
            (ActiveGetter as IDisposable)?.Dispose();
            Data.Dispose();
        }
    }

    // Master.esp: worldspace → block → subblock → ExtCell with two persistent placed refs (refA has
    // a Base set so deep-copy can be verified; refB is the untouched sibling). Active.esp is empty
    // but declares Master.esp as a master so the cell override resolves.
    private static PlacedFixture BuildFixture(string prefix)
    {
        FormKey cellFk = default, refAFk = default, refBFk = default;
        var refABase = FormKey.Factory("000ABC:Master.esp");

        var data = new PluginFixtureBuilder(prefix)
            .WithPlugin("Master.esp", mod =>
            {
                var wrld = mod.Worldspaces.AddNew("PlacedWorld");
                var cell = new Cell(mod) { EditorID = "ExtCell", Grid = new CellGrid { Point = new P2Int(1, 2) } };
                cellFk = cell.FormKey;
                var refA = new PlacedObject(mod)
                {
                    EditorID = "refA",
                    Base = new FormLinkNullable<IPlaceableObjectGetter>(refABase),
                };
                refAFk = refA.FormKey;
                var refB = new PlacedObject(mod) { EditorID = "refB" };
                refBFk = refB.FormKey;
                cell.Persistent.Add(refA);
                cell.Persistent.Add(refB);
                var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                sub.Items.Add(cell);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(sub);
                wrld.SubCells.Add(block);
            })
            .WithPlugin("Active.esp", mod =>
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Master.esp") }))
            .Build();

        var masterPath = Path.Combine(data.DataFolder, "Master.esp");
        var activePath = Path.Combine(data.DataFolder, "Active.esp");
        var activeModKey = ModKey.FromFileName("Active.esp");

        var masterGetter = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName("Master.esp"), masterPath), GameRelease.Fallout4);
        var activeGetter = ModFactory.ImportGetter(new ModPath(activeModKey, activePath), GameRelease.Fallout4);

        var linkCache = new IFallout4ModGetter[]
            {
                (IFallout4ModGetter)masterGetter,
                (IFallout4ModGetter)activeGetter,
            }
            .ToImmutableLinkCache<IFallout4Mod, IFallout4ModGetter>();

        return new PlacedFixture
        {
            Data = data,
            MasterGetter = masterGetter,
            ActiveGetter = activeGetter,
            LinkCache = linkCache,
            ActivePath = activePath,
            ActiveModKey = activeModKey,
            CellFk = cellFk,
            RefAFk = refAFk,
            RefBFk = refBFk,
            RefABase = refABase,
        };
    }

    private static ICellGetter SavedCell(PlacedFixture fx) =>
        ModFactory.ImportGetter(new ModPath(fx.ActiveModKey, fx.ActivePath), GameRelease.Fallout4)
            .EnumerateMajorRecords().OfType<ICellGetter>().Single(c => c.FormKey == fx.CellFk);

    [Fact]
    public async Task SaveAsync_CopyPlacedAsOverride_RefAppearsInOverrideCellWithBaseDeepCopied()
    {
        using var fx = BuildFixture("pw-placed-copy");

        // Copy-as-override stages the winner's fields as field_edit changes; for a placed ref the
        // change additionally carries ParentCell/PlacementGroup (16.2.2). The ref does not yet exist
        // in Active.esp, so the writer must materialise the cell override and deep-copy the ref in.
        var change = new PendingChange(
            Guid.NewGuid(), fx.RefAFk.ToString(), "Active.esp",
            "scale", "refr", J("null"), J("2.0"),
            "user", null, DateTime.UtcNow, "field_edit", null,
            ParentCell: fx.CellFk.ToString(), PlacementGroup: "persistent");

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        await writer.SaveAsync(fx.ActivePath, [change], GameRelease.Fallout4, fx.LinkCache);

        var copied = (IPlacedObjectGetter)SavedCell(fx).Persistent.Single(p => p.FormKey == fx.RefAFk);
        Assert.Equal(fx.RefABase, copied.Base.FormKey);
    }

    // Delete operates on a ref the plugin itself contains (matching DeleteRecords' per-plugin
    // targets): the cell with both refs lives in the plugin being edited, and the targeted ref is
    // removed from its Persistent list while its sibling is retained.
    [Fact]
    public async Task SaveAsync_DeletePlaced_RemovesRefFromCellAndKeepsSiblings()
    {
        FormKey cellFk = default, refAFk = default, refBFk = default;
        using var data = new PluginFixtureBuilder("pw-placed-delete")
            .WithPlugin("Active.esp", mod =>
            {
                var wrld = mod.Worldspaces.AddNew("PlacedWorld");
                var cell = new Cell(mod) { EditorID = "ExtCell", Grid = new CellGrid { Point = new P2Int(1, 2) } };
                cellFk = cell.FormKey;
                var refA = new PlacedObject(mod) { EditorID = "refA" };
                refAFk = refA.FormKey;
                var refB = new PlacedObject(mod) { EditorID = "refB" };
                refBFk = refB.FormKey;
                cell.Persistent.Add(refA);
                cell.Persistent.Add(refB);
                var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                sub.Items.Add(cell);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(sub);
                wrld.SubCells.Add(block);
            })
            .Build();

        var activePath = Path.Combine(data.DataFolder, "Active.esp");
        var activeModKey = ModKey.FromFileName("Active.esp");
        using var activeGetter = ModFactory.ImportGetter(new ModPath(activeModKey, activePath), GameRelease.Fallout4);
        var linkCache = new IFallout4ModGetter[] { (IFallout4ModGetter)activeGetter }
            .ToImmutableLinkCache<IFallout4Mod, IFallout4ModGetter>();

        var change = new PendingChange(
            Guid.NewGuid(), refAFk.ToString(), "Active.esp",
            "$delete", "refr", J("null"), J("null"),
            "user", null, DateTime.UtcNow, "delete", null,
            ParentCell: cellFk.ToString(), PlacementGroup: "persistent");

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        await writer.SaveAsync(activePath, [change], GameRelease.Fallout4, linkCache);

        using var saved = ModFactory.ImportGetter(new ModPath(activeModKey, activePath), GameRelease.Fallout4);
        var cell = saved.EnumerateMajorRecords().OfType<ICellGetter>().Single(c => c.FormKey == cellFk);
        Assert.DoesNotContain(cell.Persistent, p => p.FormKey == refAFk);
        Assert.Contains(cell.Persistent, p => p.FormKey == refBFk);
    }
}
