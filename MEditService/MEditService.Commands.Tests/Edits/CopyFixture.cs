using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Two mod folders and one load order, since a copy across plugins is unaskable of one.
/// <see cref="SourcePlugin"/> defaults untracked: a Data-directory master's own file is its only
/// representation. No index anywhere in it.</summary>
public sealed class CopyFixture : TestInstance, ITrackedPlugins
{
    public const string SourcePluginName = "Source.esm";
    public const string SourceOrigin = "SourceMod";
    public const string DestinationPluginName = "Destination.esp";
    public const string DestinationOrigin = "DestinationMod";

    public string SourceModFolder => FolderOf(SourceOrigin);
    public string DestinationModFolder => FolderOf(DestinationOrigin);
    public PluginAddress SourcePlugin { get; }
    public PluginAddress DestinationPlugin { get; }

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
        var sourceMod = new Fallout4Mod(ModKey.FromFileName(SourcePluginName), Fallout4Release.Fallout4);
        var npc = sourceMod.Npcs.AddNew(SourceNpcEditorId);
        var namelessNpc = sourceMod.Npcs.AddNew((string?)null);
        var faction = sourceMod.Factions.AddNew(SelfLinkingFactionEditorId);
        var relation = new Relation();
        relation.Target.SetTo(faction);
        faction.Relations.Add(relation);
        SourcePlugin = Add(sourceMod, SourceOrigin, trackSource);
        (SourceNpc, SelfLinkingFaction) = (npc.FormKey, faction.FormKey);
        SourceNpcWithNoEditorId = namelessNpc.FormKey;

        var destinationMod = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4);
        var destinationNpc = destinationMod.Npcs.AddNew(DestinationNpcEditorId);
        DestinationPlugin = Add(destinationMod, DestinationOrigin);
        DestinationNpc = destinationNpc.FormKey;
    }

    /// <summary>Commits the destination's working tree, so what it holds now is what HEAD holds —
    /// the state a later working-tree deletion does not free.</summary>
    public void CommitDestination()
    {
        TrackedTree.Commit(DestinationModFolder);
    }

    /// <summary>The source plugin's own bytes, so "a copy, not a move" is asserted against the file
    /// an untracked source is read from.</summary>
    public byte[] SourcePluginBytes() => File.ReadAllBytes(Path.Combine(SourceModFolder, SourcePluginName));

    public static CopyFixture Create(bool trackSource = false) => new(trackSource);
}
