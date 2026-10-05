using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A tracked mod holding the one shape a flat record cannot show: a worldspace, whose
/// directory a FormID edit moves whole, subtree and all. No index anywhere in it.</summary>
public sealed class SourceContainerFixture : IDisposable, ITrackedPlugin
{
    public const string PluginName = "SourceContainer.esp";
    public const string Origin = "SourceContainerMod";
    public const string WorldspaceEditorId = "FixtureWorld";
    public const string TopCellEditorId = "FixtureTopCell";
    public const string TopCellRefEditorId = "FixtureTopCellRef";

    public string ModFolder { get; }
    public string GameDirectory { get; }
    public LoadOrderSnapshot LoadOrder { get; }
    public EditRecordHandler EditHandler { get; }

    /// <summary>The same snapshot as a list, for a test reconciling an index over this tree.</summary>
    public IReadOnlyList<LoadOrderEntry> Entries { get; }
    public PluginAddress Plugin { get; } = new(PluginName, Origin);
    public FormKey Worldspace { get; }
    public FormKey TopCell { get; }
    public FormKey TopCellRef { get; }

    public SourceContainerFixture()
    {
        var holder = new LoadOrderHolder();
        ModFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot.Path, "mods", Origin)).FullName;
        GameDirectory = Directory.CreateDirectory(Path.Combine(_instanceRoot.Path, "game")).FullName;

        var pluginPath = Path.Combine(ModFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var worldspace = new Worldspace(mod) { EditorID = WorldspaceEditorId };
        var topCell = new Cell(mod) { EditorID = TopCellEditorId, WaterHeight = 5f };
        var topCellRef = new PlacedObject(mod)
        {
            EditorID = TopCellRefEditorId,
            Position = new P3Float(7f, 8f, 9f),
            Scale = 6f,
        };
        topCell.Temporary.Add(topCellRef);
        worldspace.TopCell = topCell;
        mod.Worldspaces.Add(worldspace);
        TrackedTemplates.WriteTracked(ModFolder, mod);
        (Worldspace, TopCell, TopCellRef) = (worldspace.FormKey, topCell.FormKey, topCellRef.FormKey);

        Entries = [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)];
        LoadOrder = SnapshotPlugins.Snapshot(GameDirectory, _instanceRoot, GameRelease.Fallout4, Entries);

        holder.Apply(LoadOrder);
        EditHandler = TestEditService.EditHandler(holder);
    }

    private readonly ScratchDirectory _instanceRoot = new("medit-source-container-");

    public void Dispose() => _instanceRoot.Dispose();
}
