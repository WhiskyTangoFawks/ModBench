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

/// <summary>Two tracked mods sharing one plugin filename (ADR-0012), one winning and one losing,
/// plus a third mod to copy from. No index anywhere in it.</summary>
public sealed class LosingCopyFixture : IDisposable
{
    public const string PluginName = "Shared.esp";
    public const string WinningOrigin = "WinningMod";
    public const string LosingOrigin = "LosingMod";
    public const string SourcePluginName = "CopySource.esm";
    public const string SourceOrigin = "CopySourceMod";

    public const string WinningNpcEditorId = "WinningNpc";
    public const string LosingNpcEditorId = "LosingNpc";
    public const string CopySourceNpcEditorId = "CopySourceNpc";

    public string WinningModFolder { get; }
    public string LosingModFolder { get; }
    public string SourceModFolder { get; }
    public string GameDirectory { get; }

    public IReadOnlyList<LoadOrderEntry> Entries { get; }
    public LoadOrderSnapshot LoadOrder { get; }

    public PluginCopyKey WinningPlugin { get; } = new(PluginName, WinningOrigin);
    public PluginCopyKey LosingPlugin { get; } = new(PluginName, LosingOrigin);
    public PluginCopyKey CopySourcePlugin { get; } = new(SourcePluginName, SourceOrigin);

    public FormKey WinningNpc { get; }
    public FormKey LosingNpc { get; }
    public FormKey CopySourceNpc { get; }

    public EditRecordHandler EditHandler { get; }
    public DeleteRecordHandler DeleteHandler { get; }
    public CreateRecordHandler CreateHandler { get; }
    public RenumberRecordHandler RenumberHandler { get; }
    public CopyRecordAsOverrideHandler CopyAsOverrideHandler { get; }
    public CopyRecordAsNewRecordHandler CopyAsNewHandler { get; }

    private LosingCopyFixture()
    {
        var holder = new LoadOrderHolder();
        WinningModFolder = Directory.CreateTempSubdirectory("medit-losing-copy-winner-").FullName;
        LosingModFolder = Directory.CreateTempSubdirectory("medit-losing-copy-loser-").FullName;
        SourceModFolder = Directory.CreateTempSubdirectory("medit-losing-copy-source-").FullName;
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

        // A losing copy of a listed name carries the winning one's own slot (PluginMetadata). The
        // copy source loads before both, so copying into either is never an underride.
        Entries =
        [
            new LoadOrderEntry(SourcePluginName, sourcePath, SourceOrigin, Slot: 0, Enabled: true, Winning: true),
            new LoadOrderEntry(PluginName, winningPath, WinningOrigin, Slot: 1, Enabled: true, Winning: true),
            new LoadOrderEntry(PluginName, losingPath, LosingOrigin, Slot: 1, Enabled: true, Winning: false),
        ];
        LoadOrder = new LoadOrderSnapshot(GameDirectory, GameDirectory, GameRelease.Fallout4, SnapshotCopies.Of(Entries));

        Track(WinningOrigin);
        Track(LosingOrigin);
        Track(SourceOrigin);

        holder.Apply(LoadOrder);
        EditHandler = TestEditService.EditHandler(holder);
        DeleteHandler = TestEditService.DeleteHandler(holder);
        CreateHandler = TestEditService.CreateHandler(holder);
        RenumberHandler = TestEditService.RenumberHandler(holder);
        CopyAsOverrideHandler = TestEditService.CopyAsOverrideHandler(holder);
        CopyAsNewHandler = TestEditService.CopyAsNewHandler(holder);
    }

    public static LosingCopyFixture Create() => new();

    private void Track(string origin) =>
        new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackModAsync(LoadOrder, origin, SourcePreset.Edits).GetAwaiter().GetResult();

    public string ModFolderOf(PluginCopyKey plugin) => plugin.Origin switch
    {
        WinningOrigin => WinningModFolder,
        LosingOrigin => LosingModFolder,
        _ => SourceModFolder,
    };

    public SourceDocument? Document(PluginCopyKey plugin, string formKey) =>
        TrackedTree.Document(ModFolderOf(plugin), plugin, formKey);

    public IReadOnlyList<string> GitStatus(PluginCopyKey plugin) => TrackedTree.GitStatus(ModFolderOf(plugin));

    public void Dispose()
    {
        TryDelete(WinningModFolder);
        TryDelete(LosingModFolder);
        TryDelete(SourceModFolder);
        TryDelete(GameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
