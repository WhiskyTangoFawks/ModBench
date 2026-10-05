using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Two tracked mods sharing one plugin filename (ADR-0012), one winning and one overridden;
/// a winning plugin plugins.txt does not list; and a plain winning destination. No index anywhere
/// in it.</summary>
public sealed class OverriddenAndUnlistedFixture : TestInstance, ITrackedPlugins
{
    public const string PluginName = "Shared.esp";
    public const string WinningOrigin = "WinningMod";
    public const string OverriddenOrigin = "OverriddenMod";
    public const string SourcePluginName = "CopySource.esm";
    public const string SourceOrigin = "CopySourceMod";
    public const string DestinationPluginName = "Destination.esp";
    public const string DestinationOrigin = "DestinationMod";
    public const string UnlistedPluginName = "Unlisted.esp";
    public const string UnlistedOrigin = "UnlistedMod";

    public const string WinningNpcEditorId = "WinningNpc";
    public const string OverriddenNpcEditorId = "OverriddenNpc";
    public const string CopySourceNpcEditorId = "CopySourceNpc";
    public const string UnlistedNpcEditorId = "UnlistedNpc";

    public string WinningModFolder => FolderOf(WinningOrigin);
    public string OverriddenModFolder => FolderOf(OverriddenOrigin);
    public string SourceModFolder => FolderOf(SourceOrigin);
    public string DestinationModFolder => FolderOf(DestinationOrigin);
    public string UnlistedModFolder => FolderOf(UnlistedOrigin);

    public PluginAddress WinningPlugin { get; }
    public PluginAddress OverriddenPlugin { get; }
    public PluginAddress CopySourcePlugin { get; }
    public PluginAddress DestinationPlugin { get; }
    public PluginAddress UnlistedPlugin { get; }

    public FormKey WinningNpc { get; }
    public FormKey OverriddenNpc { get; }
    public FormKey CopySourceNpc { get; }
    public FormKey UnlistedNpc { get; }

    private OverriddenAndUnlistedFixture()
    {
        // The copy source loads before Shared.esp and the destination after, so copying between
        // any of them is never an underride.
        var sourceMod = new Fallout4Mod(ModKey.FromFileName(SourcePluginName), Fallout4Release.Fallout4);
        CopySourceNpc = sourceMod.Npcs.AddNew(CopySourceNpcEditorId).FormKey;
        CopySourcePlugin = Add(sourceMod, SourceOrigin);

        var winningMod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        WinningNpc = winningMod.Npcs.AddNew(WinningNpcEditorId).FormKey;
        WinningPlugin = Add(winningMod, WinningOrigin);

        var overriddenMod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        OverriddenNpc = overriddenMod.Npcs.AddNew(OverriddenNpcEditorId).FormKey;
        OverriddenPlugin = Add(overriddenMod, OverriddenOrigin, listing: Listing.Overridden);

        DestinationPlugin = Add(
            new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4), DestinationOrigin);

        var unlistedMod = new Fallout4Mod(ModKey.FromFileName(UnlistedPluginName), Fallout4Release.Fallout4);
        UnlistedNpc = unlistedMod.Npcs.AddNew(UnlistedNpcEditorId).FormKey;
        UnlistedPlugin = Add(unlistedMod, UnlistedOrigin, listing: Listing.Unlisted);
    }

    public static OverriddenAndUnlistedFixture Create() => new();

    /// <summary>The bytes on disk for a tracked plugin's own binary — what a refused compile's
    /// "writes nothing" claim is checked against.</summary>
    public byte[] PluginBytes(PluginAddress plugin) => File.ReadAllBytes(Path.Combine(ModFolderOf(plugin), plugin.Name));
}
