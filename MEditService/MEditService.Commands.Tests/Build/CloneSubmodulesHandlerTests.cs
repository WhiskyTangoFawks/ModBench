using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Build;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class CloneSubmodulesHandlerTests : IDisposable
{
    private readonly ScratchDirectory _root = new("medit-clone-submodules-");
    private readonly PinnedSubmodule _submodule;

    public CloneSubmodulesHandlerTests() => _submodule = new PinnedSubmodule(_root);

    public void Dispose()
    {
        _submodule.Dispose();
        _root.Dispose();
    }

    [Fact]
    public async Task AnAbsentSubmodule_IsClonedAtItsPin_SoItsManifestIsThere()
    {
        var pin = _submodule.Commit(("build.json", "{\"files\": []}"));
        _submodule.Pin(pin);

        var answer = await TestEditService.CloneSubmodulesHandler().Clone([new Submodule(_submodule.Folder, pin, null)], CancellationToken.None);

        Assert.Equal((new SubmoduleCloned(_submodule.Folder), 0), (Assert.Single(answer.Applied), answer.Refused.Count));
        Assert.Equal(pin, PinnedSubmodule.Git(_submodule.Folder, "rev-parse", "HEAD").Trim());
        Assert.True(File.Exists(Path.Combine(_submodule.Folder, "build.json")));
    }

    [Fact]
    public async Task AClone_HandsTheRecordIndexEachPluginWhoseSourceFolderItMade_ToReadBack()
    {
        var pin = _submodule.Commit(("build.json", "{\"files\": []}"));
        _submodule.Pin(pin);
        var modFolder = Directory.CreateDirectory(Path.Combine(_root, "mods", "Cloned")).FullName;
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotPlugins.Snapshot(Directory.CreateDirectory(Path.Combine(_root, "Data")).FullName, _root, GameRelease.Fallout4,
        [
            new LoadOrderEntry("Cloned.esp", Path.Combine(modFolder, "Cloned.esp"), "Cloned", 0, Enabled: true, Winning: true,
                NamedProvider: new PluginProvider.FromMod("Cloned", modFolder, _submodule.Folder)),
        ]));
        var index = HandedWrites.Create();

        await TestEditService.CloneSubmodulesHandler(holder, index.Queries).Clone([new Submodule(_submodule.Folder, pin, null)], CancellationToken.None);

        Assert.Equal([HandedPlugin.ReadBackSource(new PluginAddress("Cloned.esp", "Cloned"))], Assert.Single(index.Hands).Require());
    }

    [Fact]
    public async Task ACloneOfAFolderTheLoadOrderNamesAsNoPluginsSource_LogsWhyTheRecordIndexHasNotReadIt()
    {
        var pin = _submodule.Commit(("build.json", "{\"files\": []}"));
        _submodule.Pin(pin);
        List<LogEntry> logged = [];

        await TestEditService.Over(new LoadOrderHolder(), logging: logging => logging.AddProvider(new CollectingLoggerProvider(logged)))
            .GetRequiredService<CloneSubmodulesHandler>().Clone([new Submodule(_submodule.Folder, pin, null)], CancellationToken.None);

        Assert.Contains(logged, entry => entry.Level == LogLevel.Warning
            && entry.Message.Contains($"the load order names no plugin source in {_submodule.Folder}", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ASubmoduleAtAnotherCommitThanItsPin_IsNamedWithTheCommit_AndLeftThere()
    {
        var first = _submodule.Commit(("build.json", "{\"files\": []}"));
        var second = _submodule.Commit(("notes.txt", "later"));
        _submodule.Pin(second);
        await TestEditService.CloneSubmodulesHandler().Clone([new Submodule(_submodule.Folder, second, null)], CancellationToken.None);

        var answer = await TestEditService.CloneSubmodulesHandler().Clone([new Submodule(_submodule.Folder, first, null)], CancellationToken.None);

        Assert.Equal(
            (new SubmoduleNotCloned(_submodule.Folder, CloneRefusal.AtAnotherCommit, $"its submodule is at {second}, not at {first}, the commit the instance repository pins"), 0),
            (Assert.Single(answer.Refused), answer.Applied.Count));
        Assert.Equal(second, PinnedSubmodule.Git(_submodule.Folder, "rev-parse", "HEAD").Trim());
    }

    [Fact]
    public async Task ASubmoduleWhosePinItsRemoteLacks_IsNotCloned_NamingWhy()
    {
        _submodule.Commit(("build.json", "{}"));
        const string Unpushed = "0123456789012345678901234567890123456789";
        _submodule.Pin(Unpushed);

        var answer = await TestEditService.CloneSubmodulesHandler().Clone([new Submodule(_submodule.Folder, Unpushed, null)], CancellationToken.None);

        Assert.Equal(
            (new SubmoduleNotCloned(_submodule.Folder, CloneRefusal.NotCloned, $"its remote holds no commit {Unpushed}"), 0),
            (Assert.Single(answer.Refused), answer.Applied.Count));
    }
}
