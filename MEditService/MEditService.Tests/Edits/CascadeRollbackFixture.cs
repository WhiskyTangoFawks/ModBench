using MEditService.Api;
using MEditService.Bridge;
using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>Three mods, each its own repository, and one record two of the others reference: a
/// cascade spanning one folder could not show several working trees rewritten, nor several
/// restored. No index unless <see cref="Watched"/> asks for one.</summary>
public sealed class CascadeRollbackFixture : IDisposable
{
    public const string RaceEditorId = "RollbackRace";
    public const string HomeNpcEditorId = "HomeNpc";
    public const string FirstNpcEditorId = "FirstNpc";
    public const string SecondNpcEditorId = "SecondNpc";

    private const string TargetName = "Target.esp";
    private const string FirstName = "First.esp";
    private const string SecondName = "Second.esp";

    private const string TargetMod = "TargetMod";
    private const string FirstMod = "FirstMod";
    private const string SecondMod = "SecondMod";

    private readonly ScatteredFixtureData _data;
    private readonly ModFolderWatcher? _watcher;

    /// <summary>Null unless <see cref="Watched"/> built one: the write side reads the load order
    /// value, and only the projection question needs an Index.</summary>
    public IndexProjector? Index { get; }

    public LoadOrder LoadOrder { get; }
    public RenumberRecordHandler RenumberHandler { get; }

    /// <summary>The same snapshot as a list, for a test reconciling an index over these trees.</summary>
    public IReadOnlyList<LoadOrderEntry> Entries => _data.Plugins;

    public string GameDirectory => _data.GameDirectory;
    public PluginKey TargetPlugin { get; } = new(TargetName, TargetMod);
    public PluginKey FirstPlugin { get; } = new(FirstName, FirstMod);
    public PluginKey SecondPlugin { get; } = new(SecondName, SecondMod);

    public FormKey Race { get; }
    public FormKey HomeNpc { get; }
    public FormKey FirstNpc { get; }
    public FormKey SecondNpc { get; }

    /// <summary>ADR-0015 invariant 2: with the Source watcher wired the way the composition root
    /// wires it, a write reaches the Index the one way production allows.</summary>
    public static CascadeRollbackFixture Watched() => new(watched: true);

    public CascadeRollbackFixture() : this(watched: false)
    {
    }

    private CascadeRollbackFixture(bool watched)
    {
        var holder = new LoadOrderHolder();
        FormKey race = default;
        FormKey home = default;
        FormKey first = default;
        FormKey second = default;

        _data = new PluginFixtureBuilder("medit-renumber-rollback")
            .WithPlugin(TargetName, mod =>
            {
                var added = mod.Races.AddNew(RaceEditorId);
                race = added.FormKey;
                var homeNpc = mod.Npcs.AddNew(HomeNpcEditorId);
                homeNpc.Race.SetTo(added);
                home = homeNpc.FormKey;
            }, origin: TargetMod)
            .WithPlugin(FirstName, mod =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName(TargetName) });
                var npc = mod.Npcs.AddNew(FirstNpcEditorId);
                npc.Race.SetTo(race);
                first = npc.FormKey;
            }, origin: FirstMod)
            .WithPlugin(SecondName, mod =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName(TargetName) });
                var npc = mod.Npcs.AddNew(SecondNpcEditorId);
                npc.Race.SetTo(race);
                second = npc.FormKey;
            }, origin: SecondMod)
            .BuildScattered();

        (Race, HomeNpc, FirstNpc, SecondNpc) = (race, home, first, second);

        LoadOrder = new LoadOrder(_data.GameDirectory, _data.GameDirectory, GameRelease.Fallout4, SnapshotCopies.Of(_data.Plugins));

        var track = new TrackService(NullLogger<TrackService>.Instance);
        foreach (var origin in new[] { TargetMod, FirstMod, SecondMod })
        {
            track.TrackAsync(LoadOrder, [.. LoadOrder.Copies.Select(c => c.Key)], origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        holder.Apply(LoadOrder);
        RenumberHandler = TestEditService.RenumberHandler(holder);

        if (!watched) return;

        Index = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        Index.Reconcile(holder, _data.GameDirectory, _data.Plugins, GameRelease.Fallout4);

        // Short, because a test waits on the projection rather than on the clock; the composition
        // root's own window is 300 ms.
        _watcher = TestWatcher.Over(
            holder, Index, new InMemoryNotificationPublisher(), TimeSpan.FromMilliseconds(100));
        _watcher.Rearm(holder.Current);
    }

    public string ModFolderOf(PluginKey plugin) => ModFolders.Of(LoadOrder, plugin)!;

    public string SourceFileOf(PluginKey plugin, FormKey formKey, string recordType, string editorId) =>
        SourceDocumentPath.Of(
            ModFolderOf(plugin), plugin.Name, recordType, formKey.ToString(), editorId, GameRelease.Fallout4);

    /// <summary>Where the race's own file lands once it is renumbered: asked of the repository at the
    /// requested target FormKey, the same door <see cref="SourceFileOf"/> uses for the record's
    /// current file.</summary>
    public string RenumberedRacePath(string newFormKey) =>
        SourceDocumentPath.Of(ModFolderOf(TargetPlugin), TargetPlugin.Name, "race", newFormKey, RaceEditorId, GameRelease.Fallout4);

    /// <summary>Every path the cascade writes, in no particular order: the three documents that
    /// reference the race and the race's own new file.</summary>
    public IReadOnlyList<string> CascadeWritePaths(string newFormKey) =>
    [
        SourceFileOf(TargetPlugin, HomeNpc, "npc_", HomeNpcEditorId),
        SourceFileOf(FirstPlugin, FirstNpc, "npc_", FirstNpcEditorId),
        SourceFileOf(SecondPlugin, SecondNpc, "npc_", SecondNpcEditorId),
        RenumberedRacePath(newFormKey),
    ];

    /// <summary>Waits until the Index answers <paramref name="condition"/>, parking each round on the
    /// projection sequence: a renumber's file moves can settle as more than one batch.</summary>
    public async Task<bool> ProjectionReaches(Func<IRecordReads, bool> condition)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            if (condition(Index!.Store!.At(RecordRef.Effective))) return true;
            await Index.AwaitSequenceAsync(Index.Sequence + 1, TimeSpan.FromSeconds(2));
        }
        return condition(Index!.Store!.At(RecordRef.Effective));
    }

    public IReadOnlyDictionary<string, IReadOnlyList<string>> Snapshots() =>
        AllPlugins.ToDictionary(p => p.Name, p => TreeSnapshot.Of(ModFolderOf(p)));

    public IReadOnlyDictionary<string, IReadOnlyList<string>> GitStatuses() =>
        AllPlugins.ToDictionary(
            p => p.Name,
            IReadOnlyList<string> (p) => GitCli
                .Run(Path.Combine(ModFolderOf(p), ".git"), ModFolderOf(p), "status", "--porcelain")
                .Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .Select(l => l.Trim())
                .ToList());

    public PluginKey[] AllPlugins => [TargetPlugin, FirstPlugin, SecondPlugin];

    public void Dispose()
    {
        _watcher?.Dispose();
        Index?.Dispose();
        try { _data.Dispose(); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
