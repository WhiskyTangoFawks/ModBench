using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Two mod folders and one load order, since a copy across plugins is unaskable of one.
/// <see cref="SourcePlugin"/> defaults untracked: a Data-directory master's own file is its only
/// representation. No index anywhere in it.</summary>
public sealed class CopyFixture : IDisposable
{
    public const string SourcePluginName = "Source.esm";
    public const string SourceOrigin = "SourceMod";
    public const string DestinationPluginName = "Destination.esp";
    public const string DestinationOrigin = "DestinationMod";

    public string SourceModFolder { get; }
    public string DestinationModFolder { get; }
    public string GameDirectory { get; }
    /// <summary>The same snapshot as a list, for a test that reconciles an index over these trees.</summary>
    public IReadOnlyList<LoadOrderEntry> Entries { get; }

    public LoadOrderSnapshot LoadOrder { get; }
    public EditRecordHandler EditHandler { get; }
    public DeleteRecordHandler DeleteHandler { get; }
    public CopyRecordAsOverrideHandler CopyAsOverrideHandler { get; }
    public CopyRecordAsNewRecordHandler CopyAsNewHandler { get; }
    public PluginCopyKey SourcePlugin { get; } = new(SourcePluginName, SourceOrigin);
    public PluginCopyKey DestinationPlugin { get; } = new(DestinationPluginName, DestinationOrigin);

    public const string SourceNpcEditorId = "SourceNpc";
    public FormKey SourceNpc { get; }

    // No EditorID at all — derivation has nothing to build a name from, so the copy lands with
    // none either (xedit.md divergence 5).
    public FormKey SourceNpcWithNoEditorId { get; }

    // Related to itself: the self-reference-follows-the-duplicate proof needs a FormLink that can
    // validly target its own record type.
    public const string SelfLinkingFactionEditorId = "SelfLinkingFaction";
    public FormKey SelfLinkingFaction { get; }

    public const string DestinationNpcEditorId = "DestinationNpc";
    public FormKey DestinationNpc { get; }

    private CopyFixture(bool trackSource)
    {
        var holder = new LoadOrderHolder();
        SourceModFolder = Directory.CreateTempSubdirectory("medit-copy-source-").FullName;
        DestinationModFolder = Directory.CreateTempSubdirectory("medit-copy-dest-").FullName;
        GameDirectory = Directory.CreateTempSubdirectory("medit-copy-game-").FullName;

        var sourcePath = Path.Combine(SourceModFolder, SourcePluginName);
        var sourceMod = new Fallout4Mod(ModKey.FromFileName(SourcePluginName), Fallout4Release.Fallout4);
        var npc = sourceMod.Npcs.AddNew(SourceNpcEditorId);
        var namelessNpc = sourceMod.Npcs.AddNew((string?)null);
        var faction = sourceMod.Factions.AddNew(SelfLinkingFactionEditorId);
        var relation = new Relation();
        relation.Target.SetTo(faction);
        faction.Relations.Add(relation);
        sourceMod.WriteToBinary(sourcePath);
        (SourceNpc, SelfLinkingFaction) = (npc.FormKey, faction.FormKey);
        SourceNpcWithNoEditorId = namelessNpc.FormKey;

        var destinationPath = Path.Combine(DestinationModFolder, DestinationPluginName);
        var destinationMod = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4);
        var destinationNpc = destinationMod.Npcs.AddNew(DestinationNpcEditorId);
        destinationMod.WriteToBinary(destinationPath);
        DestinationNpc = destinationNpc.FormKey;

        Entries =
        [
            new LoadOrderEntry(SourcePluginName, sourcePath, SourceOrigin, Slot: 0, Enabled: true, Winning: true),
            new LoadOrderEntry(DestinationPluginName, destinationPath, DestinationOrigin, Slot: 1, Enabled: true, Winning: true),
        ];
        LoadOrder = new LoadOrderSnapshot(GameDirectory, GameDirectory, GameRelease.Fallout4, SnapshotCopies.Of(Entries));

        Track(DestinationOrigin);
        if (trackSource) Track(SourceOrigin);

        holder.Apply(LoadOrder);
        EditHandler = TestEditService.EditHandler(holder);
        DeleteHandler = TestEditService.DeleteHandler(holder);
        CopyAsOverrideHandler = TestEditService.CopyAsOverrideHandler(holder);
        CopyAsNewHandler = TestEditService.CopyAsNewHandler(holder);
    }

    private void Track(string origin) =>
        new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackModAsync(LoadOrder, origin, SourcePreset.Edits).GetAwaiter().GetResult();

    /// <summary>What a tracked plugin's tree holds for a FormKey — the whole read model here.</summary>
    public SourceDocument? Document(PluginCopyKey plugin, string formKey) =>
        TrackedTree.Document(ModFolderOf(plugin), plugin, formKey);

    public SourceDocument? CommittedDocument(PluginCopyKey plugin, RecordIdentity identity) =>
        TrackedTree.CommittedDocument(ModFolderOf(plugin), plugin, identity);

    public IReadOnlyList<string> DestinationGitStatus() => TrackedTree.GitStatus(DestinationModFolder);

    /// <summary>Commits the destination's working tree, so what it holds now is what HEAD holds —
    /// the state a later working-tree deletion does not free.</summary>
    public void CommitDestination()
    {
        var gitDir = Path.Combine(DestinationModFolder, ".git");
        GitProbe.Run(gitDir, DestinationModFolder, "add", "-A");
        GitProbe.Run(gitDir, DestinationModFolder, "commit", "-m", "fixture");
    }

    /// <summary>The source plugin's own bytes, so "a copy, not a move" is asserted against the file
    /// an untracked source is read from.</summary>
    public byte[] SourcePluginBytes() => File.ReadAllBytes(Path.Combine(SourceModFolder, SourcePluginName));

    public string ModFolderOf(PluginCopyKey plugin) =>
        plugin.Origin == SourceOrigin ? SourceModFolder : DestinationModFolder;

    public static CopyFixture Create(bool trackSource = false) => new(trackSource);

    // Asked of the repository, matching TwoModFixture's own reason: computing the path needs an
    // order index this fixture has no reason to track.
    public string SourceFileFor(PluginCopyKey plugin, FormKey formKey, string recordType, string? editorId) =>
        SourceDocumentPath.Of(
            plugin.Origin == SourceOrigin ? SourceModFolder : DestinationModFolder,
            plugin.Name, recordType, formKey.ToString(), editorId, GameRelease.Fallout4);

    public void Dispose()
    {
        TryDelete(SourceModFolder);
        TryDelete(DestinationModFolder);
        TryDelete(GameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
