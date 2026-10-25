using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class InstanceScopedIndexTests : IDisposable
{
    private const string Origin = "Unofficial Patch";
    private const string Plugin = "UFO4P.esp";
    private static readonly PluginAddress Key = new(Plugin, Origin);

    private readonly ScratchDirectory _scratch = new("medit-instances-");

    private string _root => _scratch.Path;

    public void Dispose() => _scratch.Dispose();

    private string DataFolder => Directory.CreateDirectory(Path.Combine(_root, "Data")).FullName;

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
        [new(Plugin, Path.Combine(instanceRoot, "mods", Origin, Plugin), Origin, Line: 0, Enabled: true, Winning: true)];

    private static IReadOnlyList<string?> EditorIdsIn(OpenedIndex index) =>
        [.. index.ListedIn(Key).Select(row => row.EditorId)];

    [Fact]
    public void TwoInstancesOverOneDataFolder_WithSameNamedModFolders_NeverSeeEachOthersRows_OnTheWarmLoadToo()
    {
        var holder = new LoadOrderHolder();
        var dataFolder = DataFolder;
        var a = AnInstance("instance-a", "NpcFromA");
        var b = AnInstance("instance-b", "NpcFromB");

        using (var first = Indexes.Open(holder)) first.Reconcile(holder, dataFolder, OrderIn(a), GameRelease.Fallout4, a);
        using (var second = Indexes.Open(holder)) second.Reconcile(holder, dataFolder, OrderIn(b), GameRelease.Fallout4, b);

        using (var warmB = Indexes.Open(holder))
        {
            warmB.Reconcile(holder, dataFolder, OrderIn(b), GameRelease.Fallout4, b);
            Assert.Equal(["NpcFromB"], EditorIdsIn(warmB));
        }

        using var warmA = Indexes.Open(holder);
        warmA.Reconcile(holder, dataFolder, OrderIn(a), GameRelease.Fallout4, a);
        Assert.Equal(["NpcFromA"], EditorIdsIn(warmA));
    }
}
