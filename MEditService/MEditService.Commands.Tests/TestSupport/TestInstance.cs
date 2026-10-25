using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Noggog;

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
    private readonly GameRelease _release;
    private readonly Language _stringsLanguage;
    private readonly List<LoadOrderEntry> _entries = [];
    private readonly Cache<IModMasterStyledGetter, ModKey> _added = new(mod => mod.ModKey);
    private readonly Lazy<LoadOrderHolder> _holder;
    private readonly Lazy<IServiceProvider> _services;
    private LoadOrderSnapshot? _loadOrder;
    private int _nextLine;

    protected TestInstance(GameRelease release = GameRelease.Fallout4, Language stringsLanguage = Language.English)
    {
        (_release, _stringsLanguage) = (release, stringsLanguage);
        DataFolder = Directory.CreateDirectory(Path.Combine(_root, "Data")).FullName;
        _holder = new Lazy<LoadOrderHolder>(() =>
        {
            var holder = new LoadOrderHolder();
            holder.Apply(LoadOrder);
            return holder;
        });
        _services = new Lazy<IServiceProvider>(() => TestEditService.Over(Holder));
    }

    public string DataFolder { get; }

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

    public UnsavedDocuments Unsaved => _services.Value.GetRequiredService<UnsavedDocuments>();
    public TestEditor EditHandler => new(Handler<EditRecordChangesHandler>());
    public EditRecordChangesHandler EditChangesHandler => Handler<EditRecordChangesHandler>();
    public EditRecordHandler ScriptEditHandler => Handler<EditRecordHandler>();
    public CopyRecordHandler ScriptCopyHandler => Handler<CopyRecordHandler>();
    public CreateRecordHandler ScriptCreateHandler => Handler<CreateRecordHandler>();
    public DeleteRecordHandler ScriptDeleteHandler => Handler<DeleteRecordHandler>();
    public DeleteRecordChangesHandler DeleteHandler => Handler<DeleteRecordChangesHandler>();
    public CreateRecordChangesHandler CreateHandler => Handler<CreateRecordChangesHandler>();
    public CopyRecordChangesHandler CopyHandler => Handler<CopyRecordChangesHandler>();
    public CompilePluginHandler CompileHandler => Handler<CompilePluginHandler>();

    /// <summary>The folder a mod's plugins sit in. The game's Data folder and Overwrite are never mod
    /// folders (ADR-0012).</summary>
    public string FolderOf(string origin) => origin switch
    {
        PluginOrigin.DataDirectory => DataFolder,
        LoadOrderEntry.OverwriteOrigin => Path.Combine(_root, "overwrite"),
        _ => Path.Combine(_root, "mods", origin),
    };

    public string ModFolderOf(PluginAddress plugin) => FolderOf(plugin.Origin);

    /// <summary>The next plugin in load order. A compiled one is a mod's plugin, made so as it is added; one
    /// that masters another or is localized is built over the load order so far.</summary>
    protected PluginAddress Add(IMod mod, string origin, bool compiledPlugin = true, Listing listing = Listing.Winning)
    {
        if (_loadOrder is not null) throw new InvalidOperationException("The load order is sealed.");
        if (mod.GameRelease != _release) throw new InvalidOperationException($"{mod.ModKey} is a {mod.GameRelease} plugin in a {_release} instance.");
        var name = mod.ModKey.FileName.String;
        var folder = Directory.CreateDirectory(FolderOf(origin)).FullName;
        var path = Path.Combine(folder, name);
        var line = listing switch
        {
            Listing.Winning => _nextLine++,
            Listing.Overridden => _nextLine - 1,
            _ => (int?)null,
        };
        var entry = new LoadOrderEntry(name, path, origin, line, Enabled: true, Winning: listing != Listing.Overridden);
        _entries.Add(entry);

        if (!compiledPlugin) Write(mod, path);
        else if (entry.Provider is not PluginProvider.FromMod)
            throw new InvalidOperationException($"'{origin}' is not a mod, so its plugin has no folder to init.");
        else if (mod.MasterReferences.Count == 0 && !mod.UsingLocalization) CompiledPluginTemplates.WriteCompiledPlugin(folder, mod);
        else
        {
            Write(mod, path);
            Init(origin);
        }
        _added.Set(mod);

        return entry.Key;
    }

    private void Write(IMod mod, string path) => mod.WriteToBinary(path, new BinaryWriteParameters { MasterFlagsLookup = _added });

    /// <summary>The plugins added so far, by the style each one's header gives it.</summary>
    public IReadOnlyCache<IModMasterStyledGetter, ModKey> Added => _added;

    /// <summary>The repository over the mod providing <paramref name="plugin"/>, or null when its
    /// folder is not a source mod.</summary>
    public ISourceRepository? RepositoryOf(PluginAddress plugin) =>
        LoadOrder.ProviderOf(plugin) is PluginProvider.FromMod mod ? TestAdapters.Source().Open(mod, _release) : null;

    private void Init(string origin)
    {
        var result = DecompileAndCommitEveryPluginOf.ModAsync(Snapshot(), origin).GetAwaiter().GetResult();
        if (result.RefusalMessages() is { Count: > 0 } messages)
            throw new InvalidOperationException($"Expected '{origin}' to init: {string.Join("; ", messages)}");
    }

    private LoadOrderSnapshot Snapshot() => SnapshotPlugins.Snapshot(DataFolder, _root, _release, _entries, stringsLanguage: _stringsLanguage);

    /// <summary>Hands the handlers the load order again with <paramref name="plugin"/>'s entry changed, as
    /// Mod Management does after its line changes.</summary>
    public void Relist(PluginAddress plugin, Func<LoadOrderEntry, LoadOrderEntry> change)
    {
        var at = Entries.ToList().FindIndex(entry => entry.Key == plugin);
        _entries[at] = change(_entries[at]);
        _loadOrder = Snapshot();
        Holder.Apply(_loadOrder);
    }

    /// <summary>Fixes the load order: a fixture whose tests read a compiled plugin tree before any handler runs
    /// seals at the end of its construction.</summary>
    protected LoadOrderSnapshot Seal() => _loadOrder ??= Snapshot();

    private T Handler<T>() where T : notnull => _services.Value.GetRequiredService<T>();

    public virtual void Dispose() => _root.Dispose();
}
