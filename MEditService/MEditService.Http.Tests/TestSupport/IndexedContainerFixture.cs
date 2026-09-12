using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.Tests.Edits;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.TestSupport;

/// <summary>The container mod with an index over it, for the suites that are the Index side. The
/// Index reconciles over the untracked binary and Track follows, which is the order the process
/// itself has.</summary>
public sealed class IndexedContainerFixture : IDisposable
{
    private readonly ContainerModFixture _source = new(track: false);

    public IndexProjector Index { get; }

    public LoadOrderHolder Holder { get; }

    public IndexedContainerFixture(INotificationPublisher? notifications = null)
    {
        var holder = new LoadOrderHolder();
        Index = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            SharedSchemaReflector.Instance,
            notifications: notifications);
        Holder = Index.Reconcile(holder, _source.GameDirectory, _source.Entries, GameRelease.Fallout4);
        _source.Track();
    }

    public string ModFolder => _source.ModFolder;
    public string GameDirectory => _source.GameDirectory;
    public PluginKey Plugin => _source.Plugin;
    public static IReadOnlyList<RegisteredCopy> PluginCopies(string pluginPath) => ContainerModFixture.PluginCopies(pluginPath);
    public string SourceFileContaining(string editorId) => _source.SourceFileContaining(editorId);
    public IReadOnlyList<string> GitStatus() => _source.GitStatus();

    public FormKey Npc => _source.Npc;
    public FormKey Cell => _source.Cell;
    public FormKey EmbedCell => _source.EmbedCell;
    public FormKey TemporaryRef => _source.TemporaryRef;
    public FormKey PersistentRef => _source.PersistentRef;
    public FormKey Navmesh => _source.Navmesh;
    public FormKey Landscape => _source.Landscape;
    public FormKey Worldspace => _source.Worldspace;
    public FormKey TopCell => _source.TopCell;
    public FormKey TopCellRef => _source.TopCellRef;
    public FormKey Quest => _source.Quest;
    public FormKey DialogTopic => _source.DialogTopic;
    public FormKey DialogTopic2 => _source.DialogTopic2;
    public FormKey DialogTopic3 => _source.DialogTopic3;
    public FormKey Response => _source.Response;
    public FormKey Response2 => _source.Response2;
    public FormKey DialogBranch => _source.DialogBranch;
    public FormKey Scene => _source.Scene;

    public void Dispose()
    {
        Index.Dispose();
        _source.Dispose();
    }
}
