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

/// <summary>Two tracked mods sharing one plugin filename (ADR-0012), one winning and one losing;
/// a winning copy plugins.txt does not list; and a plain winning destination. No index anywhere
/// in it.</summary>
public sealed class LosingCopyFixture : IDisposable
{
    public const string PluginName = "Shared.esp";
    public const string WinningOrigin = "WinningMod";
    public const string LosingOrigin = "LosingMod";
    public const string SourcePluginName = "CopySource.esm";
    public const string SourceOrigin = "CopySourceMod";
    public const string DestinationPluginName = "Destination.esp";
    public const string DestinationOrigin = "DestinationMod";
    public const string UnlistedPluginName = "Unlisted.esp";
    public const string UnlistedOrigin = "UnlistedMod";

    public const string WinningNpcEditorId = "WinningNpc";
    public const string LosingNpcEditorId = "LosingNpc";
    public const string CopySourceNpcEditorId = "CopySourceNpc";
    public const string UnlistedNpcEditorId = "UnlistedNpc";

    public string WinningModFolder { get; }
    public string LosingModFolder { get; }
    public string SourceModFolder { get; }
    public string DestinationModFolder { get; }
    public string UnlistedModFolder { get; }
    public string GameDirectory { get; }

    public IReadOnlyList<LoadOrderEntry> Entries { get; }
    public LoadOrderSnapshot LoadOrder { get; }

    public PluginCopyKey WinningPlugin { get; } = new(PluginName, WinningOrigin);
    public PluginCopyKey LosingPlugin { get; } = new(PluginName, LosingOrigin);
    public PluginCopyKey CopySourcePlugin { get; } = new(SourcePluginName, SourceOrigin);
    public PluginCopyKey DestinationPlugin { get; } = new(DestinationPluginName, DestinationOrigin);
    public PluginCopyKey UnlistedPlugin { get; } = new(UnlistedPluginName, UnlistedOrigin);

    public FormKey WinningNpc { get; }
    public FormKey LosingNpc { get; }
    public FormKey CopySourceNpc { get; }
    public FormKey UnlistedNpc { get; }

    public EditRecordHandler EditHandler { get; }
    public DeleteRecordHandler DeleteHandler { get; }
    public CreateRecordHandler CreateHandler { get; }
    public RenumberRecordHandler RenumberHandler { get; }
    public CopyRecordAsOverrideHandler CopyAsOverrideHandler { get; }
    public CopyRecordAsNewRecordHandler CopyAsNewHandler { get; }
    public CompilePluginHandler CompileHandler { get; }

    private LosingCopyFixture()
    {
        var holder = new LoadOrderHolder();
        WinningModFolder = Directory.CreateTempSubdirectory("medit-losing-copy-winner-").FullName;
        LosingModFolder = Directory.CreateTempSubdirectory("medit-losing-copy-loser-").FullName;
        SourceModFolder = Directory.CreateTempSubdirectory("medit-losing-copy-source-").FullName;
        DestinationModFolder = Directory.CreateTempSubdirectory("medit-losing-copy-dest-").FullName;
        UnlistedModFolder = Directory.CreateTempSubdirectory("medit-losing-copy-unlisted-").FullName;
        GameDirectory = Directory.CreateTempSubdirectory("medit-losing-copy-game-").FullName;

        var winningPath = Path.Combine(WinningModFolder, PluginName);
        var winningMod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var winningNpc = winningMod.Npcs.AddNew(WinningNpcEditorId);
        winningMod.WriteToBinary(winningPath);
        WinningNpc = winningNpc.FormKey;

        var losingPath = Path.Combine(LosingModFolder, PluginName);
        var losingMod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var losingNpc = losingMod.Npcs.AddNew(LosingNpcEditorId);
        losingMod.WriteToBinary(losingPath);
        LosingNpc = losingNpc.FormKey;

        var sourcePath = Path.Combine(SourceModFolder, SourcePluginName);
        var sourceMod = new Fallout4Mod(ModKey.FromFileName(SourcePluginName), Fallout4Release.Fallout4);
        var copySourceNpc = sourceMod.Npcs.AddNew(CopySourceNpcEditorId);
        sourceMod.WriteToBinary(sourcePath);
        CopySourceNpc = copySourceNpc.FormKey;

        var destinationPath = Path.Combine(DestinationModFolder, DestinationPluginName);
        var destinationMod = new Fallout4Mod(ModKey.FromFileName(DestinationPluginName), Fallout4Release.Fallout4);
        destinationMod.WriteToBinary(destinationPath);

        var unlistedPath = Path.Combine(UnlistedModFolder, UnlistedPluginName);
        var unlistedMod = new Fallout4Mod(ModKey.FromFileName(UnlistedPluginName), Fallout4Release.Fallout4);
        var unlistedNpc = unlistedMod.Npcs.AddNew(UnlistedNpcEditorId);
        unlistedMod.WriteToBinary(unlistedPath);
        UnlistedNpc = unlistedNpc.FormKey;

        // The copy source loads before Shared.esp and the destination after, so copying between
        // any of them is never an underride. Unlisted carries no slot.
        Entries =
        [
            new LoadOrderEntry(SourcePluginName, sourcePath, SourceOrigin, Slot: 0, Enabled: true, Winning: true),
            new LoadOrderEntry(PluginName, winningPath, WinningOrigin, Slot: 1, Enabled: true, Winning: true),
            new LoadOrderEntry(PluginName, losingPath, LosingOrigin, Slot: 1, Enabled: true, Winning: false),
            new LoadOrderEntry(DestinationPluginName, destinationPath, DestinationOrigin, Slot: 2, Enabled: true, Winning: true),
            new LoadOrderEntry(UnlistedPluginName, unlistedPath, UnlistedOrigin, Slot: null, Enabled: true, Winning: true),
        ];
        LoadOrder = new LoadOrderSnapshot(GameDirectory, GameDirectory, GameRelease.Fallout4, SnapshotCopies.Of(Entries));

        Track(WinningOrigin);
        Track(LosingOrigin);
        Track(SourceOrigin);
        Track(DestinationOrigin);
        Track(UnlistedOrigin);

        holder.Apply(LoadOrder);
        EditHandler = TestEditService.EditHandler(holder);
        DeleteHandler = TestEditService.DeleteHandler(holder);
        CreateHandler = TestEditService.CreateHandler(holder);
        RenumberHandler = TestEditService.RenumberHandler(holder);
        CopyAsOverrideHandler = TestEditService.CopyAsOverrideHandler(holder);
        CopyAsNewHandler = TestEditService.CopyAsNewHandler(holder);
        CompileHandler = TestEditService.CompileHandler(holder);
    }

    public static LosingCopyFixture Create() => new();

    private void Track(string origin) =>
        new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackModAsync(LoadOrder, origin, SourcePreset.Edits).GetAwaiter().GetResult();

    public string ModFolderOf(PluginCopyKey plugin) => plugin.Origin switch
    {
        WinningOrigin => WinningModFolder,
        LosingOrigin => LosingModFolder,
        DestinationOrigin => DestinationModFolder,
        UnlistedOrigin => UnlistedModFolder,
        _ => SourceModFolder,
    };

    public SourceDocument? Document(PluginCopyKey plugin, string formKey) =>
        TrackedTree.Document(ModFolderOf(plugin), plugin, formKey);

    public IReadOnlyList<string> GitStatus(PluginCopyKey plugin) => TrackedTree.GitStatus(ModFolderOf(plugin));

    /// <summary>The bytes on disk for a tracked plugin's own binary — what a refused compile's
    /// "writes nothing" claim is checked against.</summary>
    public byte[] PluginBytes(PluginCopyKey plugin) => File.ReadAllBytes(Path.Combine(ModFolderOf(plugin), plugin.Name));

    /// <summary>The mod's question as the watcher would raise it: its binary changed outside
    /// Modbench and no answer has landed yet.</summary>
    public void RaiseExternalChangeOn(PluginCopyKey plugin, string question)
    {
        File.WriteAllBytes(Path.Combine(ModFolderOf(plugin), plugin.Name), "changed-outside-modbench"u8.ToArray());
        SourceRepository.RaiseExternalChangeQuestion(ModFolderOf(plugin), question);
    }

    public void Dispose()
    {
        TryDelete(WinningModFolder);
        TryDelete(LosingModFolder);
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
