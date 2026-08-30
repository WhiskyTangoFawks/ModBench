using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Session;

// #592 / ADR-0001: the index is one file per MO2 instance. `origin` is a mod folder name (ADR-0036)
// and every mirror table is keyed (plugin, origin), so a mirror shared any wider than the instance
// hands one instance the other's rows the moment two instances name a mod folder alike — which is
// the ordinary case, not a contrived one: everyone's Unofficial Patch folder is called the same
// thing.
//
// The two instances here deliberately share one game directory, because that is the shape the bug
// lives in: keyed by the game's Data install (#585's original answer) both instances get one file;
// keyed by the instance they never meet.
public sealed class InstanceScopedIndexTests : IDisposable
{
    private const string Origin = "Unofficial Patch";
    private const string Plugin = "UFO4P.esp";
    private static readonly PluginKey Key = new(Plugin, Origin);

    private readonly string _root = Path.Combine(Path.GetTempPath(), $"medit-instances-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    private string GameDirectory => Directory.CreateDirectory(Path.Combine(_root, "GameDir")).FullName;

    private static SessionManager MakeManager()
    {
        var reflector = SharedSchemaReflector.Instance;
        return new SessionManager(new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
    }

    /// <summary>An MO2 instance holding one mod folder — the same folder name in every instance,
    /// with its own build of the plugin inside. Returns the instance root.</summary>
    private string AnInstance(string name, string editorId)
    {
        var instanceRoot = Path.Combine(_root, name);
        var modFolder = Directory.CreateDirectory(Path.Combine(instanceRoot, "mods", Origin)).FullName;
        var mod = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(Path.Combine(modFolder, Plugin));
        return instanceRoot;
    }

    private static IReadOnlyList<ExplicitPluginInput> OrderIn(string instanceRoot) =>
        [new(Plugin, Path.Combine(instanceRoot, "mods", Origin, Plugin), Origin, Participates: true)];

    private static IReadOnlyList<string?> EditorIdsIn(SessionManager manager) =>
        [.. manager.Index!.GetDocuments(Key).Select(d => d.EditorId)];

    // AC2. Two instances, one game, the same mod folder name, different plugin bytes: neither ever
    // reads the other's records. Warm on both sides — the second load of each instance is the one
    // that would "register" the other's file_path if the mirror were shared.
    [Fact]
    public void TwoInstancesWithSameNamedModFolders_NeverSeeEachOthersRows()
    {
        var gameDirectory = GameDirectory;
        var a = AnInstance("instance-a", "NpcFromA");
        var b = AnInstance("instance-b", "NpcFromB");

        using (var first = MakeManager()) first.LoadExplicit(gameDirectory, OrderIn(a), GameRelease.Fallout4, a);
        using (var second = MakeManager()) second.LoadExplicit(gameDirectory, OrderIn(b), GameRelease.Fallout4, b);

        using var warmB = MakeManager();
        warmB.LoadExplicit(gameDirectory, OrderIn(b), GameRelease.Fallout4, b);
        Assert.Equal(["NpcFromB"], EditorIdsIn(warmB));

        using var warmA = MakeManager();
        warmA.LoadExplicit(gameDirectory, OrderIn(a), GameRelease.Fallout4, a);
        Assert.Equal(["NpcFromA"], EditorIdsIn(warmA));
    }

    // The instance is where the file lives, so a second launch on the same instance finds it — the
    // per-instance restatement of #585's warm launch, and what makes profile switches within one
    // instance cheap.
    [Fact]
    public void TheSameInstanceLoadedTwice_KeepsItsIndexBetweenLaunches()
    {
        var gameDirectory = GameDirectory;
        var a = AnInstance("instance-warm", "NpcFromA");

        using (var cold = MakeManager()) cold.LoadExplicit(gameDirectory, OrderIn(a), GameRelease.Fallout4, a);

        using var warm = MakeManager();
        warm.LoadExplicit(gameDirectory, OrderIn(a), GameRelease.Fallout4, a);
        Assert.Equal(["NpcFromA"], EditorIdsIn(warm));
    }
}
