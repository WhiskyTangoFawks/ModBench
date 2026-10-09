using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginReadabilityTests : IDisposable
{
    private const string PluginName = "Readable.esp";

    private readonly PluginFixtureData _data = new PluginFixtureBuilder("adapter-readability")
        .WithPlugin(PluginName)
        .Build();

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private string PluginPath => Path.Combine(_data.DataFolder, PluginName);

    public void Dispose() => _data.Dispose();

    private Task<PluginAnswer<PluginSource>> ReadSourceAt(string path) =>
        Adapter.ReadSourceOfAsync(
            new RegisteredPlugin(Path.GetFileName(path), PluginOrigin.DataDirectory, path, PluginProvider.Game, Line: null),
            GameRelease.Fallout4, new PluginStrings(null, _data.DataFolder));

    [Fact]
    public async Task APluginThatIsNotThere_IsInaccessible() =>
        Assert.IsType<PluginFailure.Inaccessible>((await ReadSourceAt(Path.Combine(_data.DataFolder, "Absent.esp"))).Failure());

    [Fact]
    public void TheContentOfAPluginThatIsNotThere_IsInaccessible()
    {
        var path = Path.Combine(_data.DataFolder, "Absent.esp");

        var read = Adapter.ReadContent(new ModPath(ModKey.FromFileName("Absent.esp"), path), GameRelease.Fallout4);

        Assert.IsType<PluginFailure.Inaccessible>(read.Failure());
    }

    [Fact]
    public async Task AnEmptyFile_OpensAndIsUnparsed()
    {
        var path = Path.Combine(_data.DataFolder, "Empty.esp");
        File.WriteAllBytes(path, []);

        Assert.IsType<PluginFailure.Unparsed>((await ReadSourceAt(path)).Failure());
    }

    [Fact]
    public async Task APluginAnotherHandleHoldsAgainstSharing_IsInaccessible_UntilThatHandleCloses()
    {
        using (new FileStream(PluginPath, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            Assert.IsType<PluginFailure.Inaccessible>((await ReadSourceAt(PluginPath)).Failure());
        }

        Assert.NotEmpty((await ReadSourceAt(PluginPath)).Answered().Files);
    }

    [Fact]
    public async Task ADirectoryAtThePluginsPath_IsInaccessible()
    {
        var path = Path.Combine(_data.DataFolder, "Folder.esp");
        Directory.CreateDirectory(path);

        Assert.IsType<PluginFailure.Inaccessible>((await ReadSourceAt(path)).Failure());
    }
}
