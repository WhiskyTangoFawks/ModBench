using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Plugins;

// ADR-0009: one index file per MO2 instance. The two instances share one game directory on purpose,
// the shape the bug lives in: keyed by the Data install both get one index file; keyed by the
// instance they never meet.
public sealed class InstanceScopedIndexTests : IDisposable
{
    private const string Origin = "Unofficial Patch";
    private const string Plugin = "UFO4P.esp";
    private static readonly PluginCopyKey Key = new(Plugin, Origin);

    private readonly string _root = Path.Combine(Path.GetTempPath(), $"medit-instances-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private string GameDirectory => Directory.CreateDirectory(Path.Combine(_root, "GameDir")).FullName;

    private static IndexProjector MakeManager(LoadOrderHolder holder)
    {
        var reflector = SharedSchemaReflector.Instance;
        return new IndexProjector(holder, MutagenPluginAdapter.Instance, new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
    }

    private string AnInstance(string name, string editorId)
    {
        var instanceRoot = Path.Combine(_root, name);
        var modFolder = Directory.CreateDirectory(Path.Combine(instanceRoot, "mods", Origin)).FullName;
        var mod = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(Path.Combine(modFolder, Plugin));
        return instanceRoot;
    }

    private static IReadOnlyList<LoadOrderEntry> OrderIn(string instanceRoot) =>
        [new(Plugin, Path.Combine(instanceRoot, "mods", Origin, Plugin), Origin, Slot: 0, Enabled: true, Winning: true)];

    // Records only: the plugin header is a document too, and its EditorID is null by definition, so
    // including it would put a meaningless null in front of every expectation here.
    private static IReadOnlyList<string?> EditorIdsIn(IndexProjector manager) =>
        [.. manager.Store!.At(RecordRef.Effective).GetDocuments(Key)
            .Where(d => d.RecordType != PluginHeader.RecordType)
            .Select(d => d.EditorId)];

    // Warm on both sides: the second load of each instance is the one that would register the other's
    // file_path if the store were shared.
    [Fact]
    public void TwoInstancesWithSameNamedModFolders_NeverSeeEachOthersRows()
    {
        var holder = new LoadOrderHolder();
        var gameDirectory = GameDirectory;
        var a = AnInstance("instance-a", "NpcFromA");
        var b = AnInstance("instance-b", "NpcFromB");

        using (var first = MakeManager(holder)) first.Reconcile(holder, gameDirectory, OrderIn(a), GameRelease.Fallout4, a);
        using (var second = MakeManager(holder)) second.Reconcile(holder, gameDirectory, OrderIn(b), GameRelease.Fallout4, b);

        using var warmB = MakeManager(holder);
        warmB.Reconcile(holder, gameDirectory, OrderIn(b), GameRelease.Fallout4, b);
        Assert.Equal(["NpcFromB"], EditorIdsIn(warmB));

        using var warmA = MakeManager(holder);
        warmA.Reconcile(holder, gameDirectory, OrderIn(a), GameRelease.Fallout4, a);
        Assert.Equal(["NpcFromA"], EditorIdsIn(warmA));
    }

    // The instance is where the file lives, so a second launch on the same instance finds it —
    // what makes warm launches and profile switches within one instance cheap.
    [Fact]
    public void TheSameInstanceLoadedTwice_KeepsItsIndexBetweenLaunches()
    {
        var holder = new LoadOrderHolder();
        var gameDirectory = GameDirectory;
        var a = AnInstance("instance-warm", "NpcFromA");

        using (var cold = MakeManager(holder)) cold.Reconcile(holder, gameDirectory, OrderIn(a), GameRelease.Fallout4, a);

        using var warm = MakeManager(holder);
        warm.Reconcile(holder, gameDirectory, OrderIn(a), GameRelease.Fallout4, a);
        Assert.Equal(["NpcFromA"], EditorIdsIn(warm));
    }
}
