using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Two tracked mods sharing one plugin filename (ADR-0012), one winning and one overridden;
/// a winning plugin plugins.txt does not list; and a plain winning destination. No index anywhere
/// in it.</summary>
public sealed class OverriddenAndUnlistedFixture : IDisposable
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

    public string WinningModFolder { get; }
    public string OverriddenModFolder { get; }
    public string SourceModFolder { get; }
    public string DestinationModFolder { get; }
    public string UnlistedModFolder { get; }
    public string GameDirectory { get; }

    public IReadOnlyList<LoadOrderEntry> Entries { get; }
    public LoadOrderSnapshot LoadOrder { get; }

    public PluginAddress WinningPlugin { get; } = new(PluginName, WinningOrigin);
    public PluginAddress OverriddenPlugin { get; } = new(PluginName, OverriddenOrigin);
    public PluginAddress CopySourcePlugin { get; } = new(SourcePluginName, SourceOrigin);
    public PluginAddress DestinationPlugin { get; } = new(DestinationPluginName, DestinationOrigin);
    public PluginAddress UnlistedPlugin { get; } = new(UnlistedPluginName, UnlistedOrigin);

    public FormKey WinningNpc { get; }
    public FormKey OverriddenNpc { get; }
    public FormKey CopySourceNpc { get; }
    public FormKey UnlistedNpc { get; }

    public EditRecordHandler EditHandler { get; }
    public DeleteRecordHandler DeleteHandler { get; }
    public CreateRecordHandler CreateHandler { get; }
    public CopyRecordHandler CopyHandler { get; }
    public CompilePluginHandler CompileHandler { get; }

    private OverriddenAndUnlistedFixture()
    {
        var holder = new LoadOrderHolder();
        WinningModFolder = Directory.CreateTempSubdirectory("medit-overridden-unlisted-winner-").FullName;
        OverriddenModFolder = Directory.CreateTempSubdirectory("medit-overridden-unlisted-overridden-").FullName;
        SourceModFolder = Directory.CreateTempSubdirectory("medit-overridden-unlisted-source-").FullName;
        DestinationModFolder = Directory.CreateTempSubdirectory("medit-overridden-unlisted-dest-").FullName;
        UnlistedModFolder = Directory.CreateTempSubdirectory("medit-overridden-unlisted-unlisted-").FullName;
        GameDirectory = Directory.CreateTempSubdirectory("medit-overridden-unlisted-game-").FullName;

        var winningPath = Path.Combine(WinningModFolder, PluginName);
        var winningMod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var winningNpc = winningMod.Npcs.AddNew(WinningNpcEditorId);
        TrackedTemplates.WriteTracked(WinningModFolder, winningMod);
        WinningNpc = winningNpc.FormKey;

        var overriddenPath = Path.Combine(OverriddenModFolder, PluginName);
        var overriddenMod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var overriddenNpc = overriddenMod.Npcs.AddNew(OverriddenNpcEditorId);
        TrackedTemplates.WriteTracked(OverriddenModFolder, overriddenMod);
        OverriddenNpc = overriddenNpc.FormKey;

        var sourcePath = Path.Combine(SourceModFolder, SourcePluginName);
        var sourceMod = new Fallout4Mod(ModKey.FromFileName(SourcePluginName), Fallout4Release.Fallout4);
        var copySourceNpc = sourceMod.Npcs.AddNew(CopySourceNpcEditorId);
        TrackedTemplates.WriteTracked(SourceModFolder, sourceMod);
        CopySourceNpc = copySourceNpc.FormKey;

        var destinationPath = Path.Combine(DestinationModFolder, DestinationPluginName);
        var destinationMod = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4);
        TrackedTemplates.WriteTracked(DestinationModFolder, destinationMod);

        var unlistedPath = Path.Combine(UnlistedModFolder, UnlistedPluginName);
        var unlistedMod = new Fallout4Mod(ModKey.FromFileName(UnlistedPluginName), Fallout4Release.Fallout4);
        var unlistedNpc = unlistedMod.Npcs.AddNew(UnlistedNpcEditorId);
        TrackedTemplates.WriteTracked(UnlistedModFolder, unlistedMod);
        UnlistedNpc = unlistedNpc.FormKey;

        // The copy source loads before Shared.esp and the destination after, so copying between
        // any of them is never an underride. Unlisted carries no slot.
        Entries =
        [
            new LoadOrderEntry(SourcePluginName, sourcePath, SourceOrigin, Slot: 0, Enabled: true, Winning: true),
            new LoadOrderEntry(PluginName, winningPath, WinningOrigin, Slot: 1, Enabled: true, Winning: true),
            new LoadOrderEntry(PluginName, overriddenPath, OverriddenOrigin, Slot: 1, Enabled: true, Winning: false),
            new LoadOrderEntry(DestinationPluginName, destinationPath, DestinationOrigin, Slot: 2, Enabled: true, Winning: true),
            new LoadOrderEntry(UnlistedPluginName, unlistedPath, UnlistedOrigin, Slot: null, Enabled: true, Winning: true),
        ];
        LoadOrder = SnapshotPlugins.Snapshot(GameDirectory, GameDirectory, GameRelease.Fallout4, Entries);

        holder.Apply(LoadOrder);
        EditHandler = TestEditService.EditHandler(holder);
        DeleteHandler = TestEditService.DeleteHandler(holder);
        CreateHandler = TestEditService.CreateHandler(holder);
        CopyHandler = TestEditService.CopyHandler(holder);
        CompileHandler = TestEditService.CompileHandler(holder);
    }

    public static OverriddenAndUnlistedFixture Create() => new();

    public string ModFolderOf(PluginAddress plugin) => plugin.Origin switch
    {
        WinningOrigin => WinningModFolder,
        OverriddenOrigin => OverriddenModFolder,
        DestinationOrigin => DestinationModFolder,
        UnlistedOrigin => UnlistedModFolder,
        _ => SourceModFolder,
    };

    public SourceDocument? Document(PluginAddress plugin, string formKey) =>
        TrackedTree.Document(ModFolderOf(plugin), plugin, formKey);

    public IReadOnlyList<string> ChangedFormKeys(PluginAddress plugin) => TrackedTree.ChangedFormKeys(ModFolderOf(plugin), plugin);

    /// <summary>The bytes on disk for a tracked plugin's own binary — what a refused compile's
    /// "writes nothing" claim is checked against.</summary>
    public byte[] PluginBytes(PluginAddress plugin) => File.ReadAllBytes(Path.Combine(ModFolderOf(plugin), plugin.Name));

    public void Dispose()
    {
        TryDelete(WinningModFolder);
        TryDelete(OverriddenModFolder);
        TryDelete(SourceModFolder);
        TryDelete(DestinationModFolder);
        TryDelete(UnlistedModFolder);
        TryDelete(GameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
