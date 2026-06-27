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

// Phase 16.2 spike — proves the cell-aware create mechanism: a new placed ref (REFR) added under
// a cell that exists only in a master is pulled into the active plugin as a cell override (via the
// reflection-driven GetOrAddAsOverride path) and survives a save round-trip. This de-risks the
// hardest unknown in 16.2 before the columns / orchestrator / frontend are built around it.
public class PluginWriterPlacedSpikeTests
{
    private static readonly ISchemaReflector _reflector = new SchemaReflector();

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    [Fact]
    public async Task SaveAsync_CreatePlacedInMasterCell_RefAppearsUnderOverriddenCell()
    {
        FormKey extCellFk = default;
        using var data = new PluginFixtureBuilder("pw-placed-spike")
            .WithPlugin("Master.esp", mod =>
            {
                var wrld = mod.Worldspaces.AddNew("SpikeWorld");
                var extCell = new Cell(mod) { EditorID = "ExtCell", Grid = new CellGrid { Point = new P2Int(1, 2) } };
                extCellFk = extCell.FormKey;
                var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                sub.Items.Add(extCell);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(sub);
                wrld.SubCells.Add(block);
            })
            // Active.esp starts empty but declares Master.esp as a master so the override resolves.
            .WithPlugin("Active.esp", mod =>
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Master.esp") }))
            .Build();

        var masterPath = Path.Combine(data.DataFolder, "Master.esp");
        var activePath = Path.Combine(data.DataFolder, "Active.esp");
        var activeModKey = ModKey.FromFileName("Active.esp");

        using var masterGetter = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName("Master.esp"), masterPath), GameRelease.Fallout4);
        using var activeGetter = ModFactory.ImportGetter(
            new ModPath(activeModKey, activePath), GameRelease.Fallout4);

        var linkCache = new IFallout4ModGetter[]
            {
                (IFallout4ModGetter)masterGetter,
                (IFallout4ModGetter)activeGetter,
            }
            .ToImmutableLinkCache<IFallout4Mod, IFallout4ModGetter>();

        var newRefFk = FormKey.Factory($"{activeGetter.NextFormID:X6}:Active.esp");

        var createChange = new PendingChange(
            Guid.NewGuid(), newRefFk.ToString(), "Active.esp",
            "$create", "refr",
            J("null"), J("null"),
            "user", null, DateTime.UtcNow, "create", null,
            ParentCell: extCellFk.ToString(), PlacementGroup: "persistent");

        var writer = new PluginWriter(_reflector, NullLogger<PluginWriter>.Instance);
        var result = await writer.SaveAsync(activePath, [createChange], GameRelease.Fallout4, linkCache);

        Assert.Contains("$create", result.Applied);

        using var saved = ModFactory.ImportGetter(new ModPath(activeModKey, activePath), GameRelease.Fallout4);
        var cell = saved.EnumerateMajorRecords().OfType<ICellGetter>().Single(c => c.FormKey == extCellFk);
        Assert.Contains(cell.Persistent, p => p.FormKey == newRefFk);
    }
}
