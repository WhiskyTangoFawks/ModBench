using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>Two mod folders, because the interesting question — does a renumber rewrite a FormLink in
/// a different mod folder's own repo — cannot be asked of one. No index anywhere in it.</summary>
public sealed class RenumberTwoModFixture : IDisposable
{
    public const string ReferencerPluginName = "Winner.esp";
    public const string TargetPluginName = "Base.esm";
    public const string TargetOrigin = "TargetMod";
    public const string ReferencerOrigin = "ReferencerMod";
    public const string TargetRaceEditorId = "TargetRace";
    public const string ReferencerNpcEditorId = "ReferencerNpc";

    public string TargetModFolder { get; }
    public string ReferencerModFolder { get; }
    public string GameDirectory { get; }

    /// <summary>The same snapshot as a list, for a test reconciling an index over these trees.</summary>
    public IReadOnlyList<LoadOrderEntry> Entries { get; }

    public LoadOrderSnapshot LoadOrder { get; }
    public RenumberRecordHandler RenumberHandler { get; }

    public PluginCopyKey TargetPlugin { get; } = new(TargetPluginName, TargetOrigin);
    public PluginCopyKey ReferencerPlugin { get; } = new(ReferencerPluginName, ReferencerOrigin);

    /// <summary>Native to Base.esm and overridden unedited in Winner.esp, so the override case has a
    /// record to be asked about.</summary>
    public FormKey Npc { get; }

    public FormKey TargetRace { get; }
    public FormKey ReferencerNpc { get; }

    private RenumberTwoModFixture(bool trackReferencer)
    {
        var holder = new LoadOrderHolder();
        TargetModFolder = Directory.CreateTempSubdirectory("medit-renumber-target-").FullName;
        ReferencerModFolder = Directory.CreateTempSubdirectory("medit-renumber-ref-").FullName;
        GameDirectory = Directory.CreateTempSubdirectory("medit-renumber-game-").FullName;

        var targetPath = Path.Combine(TargetModFolder, TargetPluginName);
        var targetMod = new Fallout4Mod(ModKey.FromFileName(TargetPluginName), Fallout4Release.Fallout4);
        var race = targetMod.Races.AddNew(TargetRaceEditorId);
        var npc = targetMod.Npcs.AddNew("BaseNpc");
        targetMod.WriteToBinary(targetPath);
        (TargetRace, Npc) = (race.FormKey, npc.FormKey);

        var referencerPath = Path.Combine(ReferencerModFolder, ReferencerPluginName);
        var referencerMod = new Fallout4Mod(ModKey.FromFileName(ReferencerPluginName), Fallout4Release.Fallout4);
        referencerMod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName(TargetPluginName) });
        referencerMod.Npcs.Set(targetMod.Npcs.First(n => n.FormKey == npc.FormKey).DeepCopy());
        var referencerNpc = referencerMod.Npcs.AddNew(ReferencerNpcEditorId);
        referencerNpc.Race.SetTo(race);
        referencerMod.WriteToBinary(referencerPath);
        ReferencerNpc = referencerNpc.FormKey;

        Entries =
        [
            new LoadOrderEntry(TargetPluginName, targetPath, TargetOrigin, Slot: 0, Enabled: true, Winning: true),
            new LoadOrderEntry(ReferencerPluginName, referencerPath, ReferencerOrigin, Slot: 1, Enabled: true, Winning: true),
        ];
        LoadOrder = new LoadOrderSnapshot(GameDirectory, GameDirectory, GameRelease.Fallout4, SnapshotCopies.Of(Entries));

        Track(TargetOrigin);
        if (trackReferencer) Track(ReferencerOrigin);

        holder.Apply(LoadOrder);
        RenumberHandler = TestEditService.RenumberHandler(holder);
    }

    public static RenumberTwoModFixture Create(bool trackReferencer) => new(trackReferencer);

    private void Track(string origin) =>
        new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackAsync(LoadOrder, origin, SourcePreset.Edits).GetAwaiter().GetResult();

    public string ModFolderOf(PluginCopyKey plugin) =>
        plugin.Origin == TargetOrigin ? TargetModFolder : ReferencerModFolder;

    /// <summary>What a tracked plugin's tree holds for a FormKey — the whole read model here.</summary>
    public SourceDocument? Document(PluginCopyKey plugin, FormKey formKey) =>
        TrackedTree.Document(ModFolderOf(plugin), plugin, formKey.ToString());

    public SourceDocument? Document(PluginCopyKey plugin, string formKey) =>
        TrackedTree.Document(ModFolderOf(plugin), plugin, formKey);

    /// <summary>Asked of the layout rather than the repository: a leaf name is what a renumber moves,
    /// and a test naming it ahead of the write is naming the file that must survive a refusal.</summary>
    public string SourceFileFor(PluginCopyKey plugin, FormKey formKey, string recordType, string? editorId) =>
        SourceDocumentPath.Of(
            ModFolderOf(plugin), plugin.Name, recordType, formKey.ToString(), editorId, GameRelease.Fallout4);

    public void Dispose()
    {
        TryDelete(TargetModFolder);
        TryDelete(ReferencerModFolder);
        TryDelete(GameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
