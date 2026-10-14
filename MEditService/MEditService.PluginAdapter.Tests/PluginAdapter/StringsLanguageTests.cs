using MEditService.LoadOrder;
using MEditService.PluginAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class StringsLanguageTests : IDisposable
{
    private const string PluginName = "Update.esm";

    private readonly ScratchDirectory _root = new("medit-strings-language-");
    private readonly string _pluginPath;

    public StringsLanguageTests()
    {
        _pluginPath = Path.Combine(_root, PluginName);
        LocalizedDoorPlugin.WriteNamedIn(_pluginPath, (Language.English, "The Big Door"), (Language.German, "Das Grosse Tor"));
    }

    public void Dispose() => _root.Dispose();

    private ModPath Mod => new(ModKey.FromFileName(PluginName), _pluginPath);

    private static MutagenPluginAdapter AdapterIn(Language language)
    {
        var holder = new StringsLanguageHolder();
        holder.Set(language);
        return new MutagenPluginAdapter(TimeProvider.System, holder);
    }

    private LoadOrderSnapshot LoadOrder
    {
        get
        {
            var plugin = new RegisteredPlugin(
                PluginName, PluginOrigin.DataDirectory, _pluginPath, PluginProvider.Game, Line: null, HandedStrings.Of(_pluginPath));
            return new LoadOrderSnapshot(_root, null, GameRelease.SkyrimSE, [plugin], [], [plugin.Key], [], []);
        }
    }

    [Fact]
    public void OpenDocuments_TheStringsLanguage_IsTheLanguageTheTextShowsIn()
    {
        using var documents = AdapterIn(Language.German).OpenDocuments(
            Mod, LoadOrder, SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE), HandedStrings.Of(_pluginPath)).Answered();

        Assert.Matches("\"TargetLanguage\":\\s*\"German\"", documents.Records.Single().Text);
    }

    [Fact]
    public void ReadContent_TheStringsLanguage_IsTheLanguageWhoseFilesItChecksFor()
    {
        var (content, _) = AdapterIn(Language.French).ReadContent(Mod, LoadOrder, HandedStrings.Of(_pluginPath)).Answered();

        Assert.Equal(["Update_French.STRINGS", "Update_French.ILSTRINGS", "Update_French.DLSTRINGS"], content.MissingStringsFiles);
    }

    [Fact]
    public async Task ReadSourceOf_TheStringsLanguage_IsTheLanguageWhoseFilesItChecksFor()
    {
        var plugin = LoadOrder.Plugins.Single();

        var source = await AdapterIn(Language.French).ReadSourceOfAsync(plugin, LoadOrder);

        Assert.Equal("Update_French.STRINGS", Assert.IsType<PluginFailure.MissingStrings>(source.Failure()).File);
    }

    [Fact]
    public async Task Save_OfAPluginLocalizedInOnlyTheStringsLanguage_DropsNothing()
    {
        var germanOnly = Path.Combine(Directory.CreateDirectory(Path.Combine(_root, "German")).FullName, PluginName);
        LocalizedDoorPlugin.WriteNamedIn(germanOnly, (Language.German, "Das Grosse Tor"));
        var plugin = new RegisteredPlugin(
            PluginName, PluginOrigin.DataDirectory, germanOnly, PluginProvider.Game, Line: null, HandedStrings.Of(germanOnly));
        var loadOrder = new LoadOrderSnapshot(_root, null, GameRelease.SkyrimSE, [plugin], [], [plugin.Key], [], []);
        var adapter = AdapterIn(Language.German);
        var source = (await adapter.ReadSourceOfAsync(plugin, loadOrder)).Answered();
        var tree = (await adapter.ReadTreeAsync(source.Files, loadOrder)).Answered();

        var drops = (await tree.SaveAsync(Path.Combine(_root, "Out", PluginName), source.Masters, [], tree.DropsIn)).Answered();

        Assert.Empty(drops);
    }
}
