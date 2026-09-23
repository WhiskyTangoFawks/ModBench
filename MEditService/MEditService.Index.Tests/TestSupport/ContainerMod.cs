using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>A tracked mod over <see cref="ContainerModPlugin"/>'s shared shape, the one records the
/// flat fixtures cannot exercise.</summary>
internal sealed class ContainerMod : IDisposable
{
    public const string PluginName = "ContainerFixture.esp";
    public const string Origin = "ContainerFixtureMod";
    public const string NpcEditorId = "FixtureNpc";

    private readonly ScatteredFixtureData _fixture;

    public LoadOrderEntry Entry { get; }
    public PluginCopyKey Plugin => Entry.KeyOf();
    public string GameDirectory => _fixture.GameDirectory;

    public FormKey Cell { get; }
    public FormKey EmbedCell { get; }
    public FormKey TemporaryRef { get; }
    public FormKey PersistentRef { get; }
    public FormKey Worldspace { get; }
    public FormKey TopCell { get; }
    public FormKey TopCellRef { get; }
    public FormKey Npc { get; }

    public ContainerMod()
    {
        var keys = default(ContainerModPlugin.Keys);
        FormKey npc = default;

        _fixture = new PluginFixtureBuilder("container-mod")
            .WithPlugin(PluginName, mod =>
            {
                keys = ContainerModPlugin.AddTo(mod);
                // Allocated last, so every container FormKey above keeps the value it had before a
                // flat record joined the fixture.
                npc = mod.Npcs.AddNew(NpcEditorId).FormKey;
            }, origin: Origin)
            .BuildScattered()
            .Tracked();

        Entry = _fixture.Plugins.Single();
        (Cell, EmbedCell, TemporaryRef, PersistentRef, Worldspace, TopCell, TopCellRef) =
            (keys.Cell, keys.EmbedCell, keys.TemporaryRef, keys.PersistentRef, keys.Worldspace, keys.TopCell, keys.TopCellRef);
        Npc = npc;
    }

    /// <summary>Any document of the tree: a container's own file, or the file that inlines an
    /// embedded child.</summary>
    public string SourceFileContaining(string editorId) =>
        Directory.EnumerateFiles(
                Path.Combine(Entry.ModFolderOf(), SourceRepository.RootFor(PluginName)), "*.json", SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains($"\"{editorId}\"", StringComparison.Ordinal));

    public void Dispose() => _fixture.Dispose();
}

/// <summary>The container mod with an index over it, reconciled the way the composition root
/// reconciles: the Index reads the tracked tree.</summary>
internal sealed class IndexedContainerMod : IDisposable
{
    private readonly ContainerMod _mod = new();

    public Indexer Index { get; }

    public IndexedContainerMod(INotificationPublisher? notifications = null) =>
        Index = Indexes.Reconciled(_mod.GameDirectory, [_mod.Entry], notifications: notifications);

    public ContainerMod Mod => _mod;
    public LoadOrderEntry Entry => _mod.Entry;
    public PluginCopyKey Plugin => _mod.Plugin;
    public IRecordReads Reads => Index.RequireReads();

    public string Cell => _mod.Cell.ToString();
    public string EmbedCell => _mod.EmbedCell.ToString();
    public string Npc => _mod.Npc.ToString();
    public string TemporaryRef => _mod.TemporaryRef.ToString();
    public string PersistentRef => _mod.PersistentRef.ToString();
    public string Worldspace => _mod.Worldspace.ToString();
    public string TopCell => _mod.TopCell.ToString();
    public string TopCellRef => _mod.TopCellRef.ToString();

    public void Dispose()
    {
        Index.Dispose();
        _mod.Dispose();
    }
}
