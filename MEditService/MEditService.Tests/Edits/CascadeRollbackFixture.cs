using MEditService.Api;
using MEditService.Bridge;
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
/// restored.</summary>
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
    private readonly SourceChangeWatcher? _watcher;

    public LoadOrderMirror Mirror { get; }
    public PluginKey TargetPlugin { get; } = new(TargetName, TargetMod);
    public PluginKey FirstPlugin { get; } = new(FirstName, FirstMod);
    public PluginKey SecondPlugin { get; } = new(SecondName, SecondMod);

    public FormKey Race { get; }
    public FormKey HomeNpc { get; }
    public FormKey FirstNpc { get; }
    public FormKey SecondNpc { get; }

    /// <summary>ADR-0046 invariant 4: with the Source watcher wired the way the composition root
    /// wires it, a write reaches the Index the one way production allows.</summary>
    public static CascadeRollbackFixture Watched() => new(watched: true);

    public CascadeRollbackFixture() : this(watched: false)
    {
    }

    private CascadeRollbackFixture(bool watched)
    {
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

        Mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)Mirror).Reconcile(_data.GameDirectory, _data.Plugins, GameRelease.Fallout4);

        var track = new TrackService(NullLogger<TrackService>.Instance);
        foreach (var origin in new[] { TargetMod, FirstMod, SecondMod })
            track.TrackAsync(Mirror.LoadOrder!, origin, SourcePreset.Edits).GetAwaiter().GetResult();

        if (!watched) return;

        // Short, because a test waits on the projection rather than on the clock; the composition
        // root's own window is 300 ms.
        _watcher = new SourceChangeWatcher(TimeSpan.FromMilliseconds(100));
        var sourceMirror = new SourceMirror(Mirror.Projector, Mirror.WriteGate, _watcher, new InMemoryNotificationPublisher(), NullLogger.Instance);
        _watcher.SourceChanged = sourceMirror.Apply;
        ((ILoadOrderMirror)Mirror).LoadOrderChanged = sourceMirror.RefreshWatches;
        sourceMirror.RefreshWatches();
    }

    public string ModFolderOf(PluginKey plugin) => ModFolders.Of(Mirror.LoadOrder, plugin)!;

    public string SourceFileOf(PluginKey plugin, FormKey formKey, string recordType, string editorId) =>
        SourceDocumentPath.Of(
            ModFolderOf(plugin), plugin.Name, recordType, formKey.ToString(), editorId, GameRelease.Fallout4);

    /// <summary>Where the race's own file lands once it is renumbered: the leaf name carries the
    /// FormKey, so only a requested target makes it nameable ahead of the write.</summary>
    public string RenumberedRacePath(string newFormKey) =>
        Path.Combine(
            Path.GetDirectoryName(SourceFileOf(TargetPlugin, Race, "race", RaceEditorId))!,
            SourceRepository.LeafNameFor(FormKey.Factory(newFormKey), RaceEditorId, isDirectory: false));

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
            if (condition(Mirror.Index!.At(RecordRef.Effective))) return true;
            await ((ILoadOrderMirror)Mirror).AwaitSequenceAsync(Mirror.Sequence + 1, TimeSpan.FromSeconds(2));
        }
        return condition(Mirror.Index!.At(RecordRef.Effective));
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
        Mirror.Dispose();
        try { _data.Dispose(); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
