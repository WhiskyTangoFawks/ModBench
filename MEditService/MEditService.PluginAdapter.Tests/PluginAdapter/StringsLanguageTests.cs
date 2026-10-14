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

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private readonly ScratchDirectory _root = new("medit-strings-language-");
    private readonly string _pluginPath;

    public StringsLanguageTests()
    {
        _pluginPath = Path.Combine(_root, PluginName);
        LocalizedDoorPlugin.WriteNamedIn(_pluginPath, (Language.English, "The Big Door"), (Language.German, "Das Grosse Tor"));
    }

    public void Dispose() => _root.Dispose();

    private ModPath Mod => new(ModKey.FromFileName(PluginName), _pluginPath);

    private LoadOrderSnapshot LoadOrderIn(Language language)
    {
        var plugin = new RegisteredPlugin(
            PluginName, PluginOrigin.DataDirectory, _pluginPath, PluginProvider.Game, Line: null, HandedStrings.Of(_pluginPath));
        return new LoadOrderSnapshot(_root, null, GameRelease.SkyrimSE, [plugin], [], [plugin.Key], [], [], language);
    }

    [Fact]
    public void OpenDocuments_TheSnapshotsStringsLanguage_IsTheLanguageTheTextShowsIn()
    {
        using var documents = Adapter.OpenDocuments(
            Mod, LoadOrderIn(Language.German), SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE), HandedStrings.Of(_pluginPath)).Answered();

        Assert.Matches("\"TargetLanguage\":\\s*\"German\"", documents.Records.Single().Text);
    }

    [Fact]
    public void ReadContent_TheSnapshotsStringsLanguage_IsTheLanguageWhoseFilesItChecksFor()
    {
        var (content, _) = Adapter.ReadContent(Mod, LoadOrderIn(Language.French), HandedStrings.Of(_pluginPath)).Answered();

        Assert.Equal(["Update_French.STRINGS", "Update_French.ILSTRINGS", "Update_French.DLSTRINGS"], content.MissingStringsFiles);
    }
}
