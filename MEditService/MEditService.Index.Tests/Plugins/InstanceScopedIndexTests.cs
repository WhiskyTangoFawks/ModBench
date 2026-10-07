using MEditService.Codec.Schema;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

public sealed class InstanceScopedIndexTests : IDisposable
{
    private const string Origin = "Unofficial Patch";
    private const string Plugin = "UFO4P.esp";
    private static readonly PluginAddress Key = new(Plugin, Origin);

    private readonly ScratchDirectory _scratch = new("medit-instances-");

    private string _root => _scratch.Path;

    public void Dispose() => _scratch.Dispose();

    private string GameDirectory => Directory.CreateDirectory(Path.Combine(_root, "GameDir")).FullName;

    private static OpenedIndex MakeIndexer(LoadOrderHolder holder) => Indexes.Open(holder);

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

    private static IReadOnlyList<string?> EditorIdsIn(OpenedIndex manager) =>
        [.. manager.RequireReads().DocumentsOf(Key)
            .Where(d => d.RecordType != PluginHeader.RecordType)
            .Select(d => d.EditorId)];

    [Fact]
    public void TwoInstancesOverOneGameDirectory_WithSameNamedModFolders_NeverSeeEachOthersRows_OnTheWarmLoadToo()
    {
        var holder = new LoadOrderHolder();
        var gameDirectory = GameDirectory;
        var a = AnInstance("instance-a", "NpcFromA");
        var b = AnInstance("instance-b", "NpcFromB");

        using (var first = MakeIndexer(holder)) first.Reconcile(holder, gameDirectory, OrderIn(a), GameRelease.Fallout4, a);
        using (var second = MakeIndexer(holder)) second.Reconcile(holder, gameDirectory, OrderIn(b), GameRelease.Fallout4, b);

        using (var warmB = MakeIndexer(holder))
        {
            warmB.Reconcile(holder, gameDirectory, OrderIn(b), GameRelease.Fallout4, b);
            Assert.Equal(["NpcFromB"], EditorIdsIn(warmB));
        }

        using var warmA = MakeIndexer(holder);
        warmA.Reconcile(holder, gameDirectory, OrderIn(a), GameRelease.Fallout4, a);
        Assert.Equal(["NpcFromA"], EditorIdsIn(warmA));
    }

    [Fact]
    public void TheSameInstanceLoadedTwice_KeepsItsIndexBetweenLaunches()
    {
        var holder = new LoadOrderHolder();
        var gameDirectory = GameDirectory;
        var a = AnInstance("instance-warm", "NpcFromA");

        using (var cold = MakeIndexer(holder)) cold.Reconcile(holder, gameDirectory, OrderIn(a), GameRelease.Fallout4, a);

        using var warm = MakeIndexer(holder);
        warm.Reconcile(holder, gameDirectory, OrderIn(a), GameRelease.Fallout4, a);
        Assert.Equal(["NpcFromA"], EditorIdsIn(warm));
    }
}
