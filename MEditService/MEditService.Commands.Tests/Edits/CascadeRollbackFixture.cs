using MEditService.Codec.Schema;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
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

    public LoadOrderSnapshot LoadOrder { get; }
    public RenumberRecordHandler RenumberHandler { get; }

    public string GameDirectory => _data.GameDirectory;
    public PluginCopyKey TargetPlugin { get; } = new(TargetName, TargetMod);
    public PluginCopyKey FirstPlugin { get; } = new(FirstName, FirstMod);
    public PluginCopyKey SecondPlugin { get; } = new(SecondName, SecondMod);

    public FormKey Race { get; }
    public FormKey HomeNpc { get; }
    public FormKey FirstNpc { get; }
    public FormKey SecondNpc { get; }

    public CascadeRollbackFixture()
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

        LoadOrder = new LoadOrderSnapshot(_data.GameDirectory, _data.GameDirectory, GameRelease.Fallout4, SnapshotCopies.Of(_data.Plugins));

        var track = new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance);
        foreach (var origin in new[] { TargetMod, FirstMod, SecondMod })
        {
            track.TrackAsync(LoadOrder, [.. LoadOrder.Copies.Select(c => c.Key)], origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        holder.Apply(LoadOrder);
        RenumberHandler = TestEditService.RenumberHandler(holder);
    }

    public string ModFolderOf(PluginCopyKey plugin) =>
        LoadOrder.ModFolderOf(plugin) ?? throw new InvalidOperationException($"Expected the load order to hold a mod folder for {plugin}.");

    public string SourceFileOf(PluginCopyKey plugin, FormKey formKey, string recordType, string editorId) =>
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

    public IReadOnlyDictionary<string, IReadOnlyList<string>> Snapshots() =>
        AllPlugins.ToDictionary(p => p.Name, p => TreeSnapshot.Of(ModFolderOf(p)));

    public IReadOnlyDictionary<string, IReadOnlyList<string>> GitStatuses() =>
        AllPlugins.ToDictionary(
            p => p.Name,
            IReadOnlyList<string> (p) => GitProbe
                .Run(Path.Combine(ModFolderOf(p), ".git"), ModFolderOf(p), "status", "--porcelain")
                .Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .Select(l => l.Trim())
                .ToList());

    public PluginCopyKey[] AllPlugins => [TargetPlugin, FirstPlugin, SecondPlugin];

    public void Dispose()
    {
        try { _data.Dispose(); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
