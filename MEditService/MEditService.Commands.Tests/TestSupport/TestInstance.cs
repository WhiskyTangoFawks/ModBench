using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>How a plugin stands in the load order: the winner of its line, a plugin another mod's
/// plugin of the same filename overrides, or one plugins.txt does not list.</summary>
public enum Listing { Winning, Overridden, Unlisted }

/// <summary>The scratch folder, mod folders, load order and handlers every Commands test builds. A
/// fixture derives from it, adds its plugins in load order, and reads the rest from here; the first
/// read fixes the load order.</summary>
public abstract class TestInstance : IDisposable
{
    private readonly ScratchDirectory _root = new("medit-instance-");
    private readonly List<LoadOrderEntry> _entries = [];
    private readonly Lazy<LoadOrderHolder> _holder;
    private readonly Lazy<IServiceProvider> _services;
    private LoadOrderSnapshot? _loadOrder;
    private int _nextSlot;

    protected TestInstance()
    {
        GameDirectory = Directory.CreateDirectory(Path.Combine(_root, "game")).FullName;
        _holder = new Lazy<LoadOrderHolder>(() =>
        {
            var holder = new LoadOrderHolder();
            holder.Apply(LoadOrder);
            return holder;
        });
        _services = new Lazy<IServiceProvider>(() => TestEditService.Over(Holder));
    }

    public string GameDirectory { get; }

    public LoadOrderHolder Holder => _holder.Value;

    public LoadOrderSnapshot LoadOrder => Seal();

    /// <summary>The same snapshot as a list, for a test reconciling an index over these trees.</summary>
    public IReadOnlyList<LoadOrderEntry> Entries
    {
        get
        {
            Seal();
            return _entries;
        }
    }

    public EditRecordHandler EditHandler => Handler<EditRecordHandler>();
    public DeleteRecordHandler DeleteHandler => Handler<DeleteRecordHandler>();
    public CreateRecordHandler CreateHandler => Handler<CreateRecordHandler>();
    public CopyRecordHandler CopyHandler => Handler<CopyRecordHandler>();
    public CompilePluginHandler CompileHandler => Handler<CompilePluginHandler>();

    /// <summary>The folder a mod's plugins sit in. The game's Data folder and Overwrite are never mod
    /// folders (ADR-0012).</summary>
    public string FolderOf(string origin) => origin switch
    {
        PluginOrigin.DataDirectory => GameDirectory,
        PluginOrigin.Overwrite => Path.Combine(_root, "overwrite"),
        _ => Path.Combine(_root, "mods", origin),
    };

    public string ModFolderOf(PluginAddress plugin) => FolderOf(plugin.Origin);

    /// <summary>The next plugin in load order. A tracked one is a mod's plugin, tracked as it is added;
    /// one that masters another is tracked over the load order so far, which holds its masters.</summary>
    protected PluginAddress Add(Fallout4Mod mod, string origin, bool tracked = true, Listing listing = Listing.Winning)
    {
        if (_loadOrder is not null) throw new InvalidOperationException("The load order is sealed.");
        var name = mod.ModKey.FileName.String;
        var folder = Directory.CreateDirectory(FolderOf(origin)).FullName;
        var path = Path.Combine(folder, name);
        var slot = listing switch
        {
            Listing.Winning => _nextSlot++,
            Listing.Overridden => _nextSlot - 1,
            _ => (int?)null,
        };
        var entry = new LoadOrderEntry(name, path, origin, slot, Enabled: true, Winning: listing != Listing.Overridden);
        _entries.Add(entry);

        if (!tracked) mod.WriteToBinary(path);
        else if (entry.Provider is not PluginProvider.FromMod)
            throw new InvalidOperationException($"'{origin}' is not a mod, so its plugin has no folder to track.");
        else if (mod.ModHeader.MasterReferences.Count == 0) TrackedTemplates.WriteTracked(folder, mod);
        else
        {
            mod.WriteToBinary(path);
            Track(origin);
        }

        return entry.Key;
    }

    /// <summary>The repository over the mod providing <paramref name="plugin"/>, or null when its
    /// folder is not tracked.</summary>
    public SourceRepository? RepositoryOf(PluginAddress plugin) =>
        LoadOrder.ProviderOf(plugin) is PluginProvider.FromMod mod ? SourceRepository.Open(mod, GameRelease.Fallout4) : null;

    private void Track(string origin)
    {
        var result = new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackModAsync(Snapshot(), origin).GetAwaiter().GetResult();
        if (result.Refused.Count > 0)
            throw new InvalidOperationException($"Expected '{origin}' to track: {string.Join("; ", result.Refused.Select(r => r.Message))}");
    }

    private LoadOrderSnapshot Snapshot() => SnapshotPlugins.Snapshot(GameDirectory, _root, GameRelease.Fallout4, _entries);

    /// <summary>Fixes the load order: a fixture whose tests read a tracked tree before any handler runs
    /// seals at the end of its construction.</summary>
    protected LoadOrderSnapshot Seal() => _loadOrder ??= Snapshot();

    private T Handler<T>() where T : notnull => _services.Value.GetRequiredService<T>();

    public virtual void Dispose() => _root.Dispose();
}
