using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.Http.Tests.TestSupport.Wire;

namespace MEditService.Http.Tests.Traces;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class RestoreFromManifestTraceTests : HostedTests
{
    private const string Plugin = "Restored.esp";
    private const string Origin = "RestoredMod";

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-restore-from-manifest")
        .WithPlugin(Plugin, mod => mod.Npcs.AddNew("RestoredNpc"), origin: Origin)
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    [Fact]
    public async Task RestoringASourceModWhoseSubmoduleIsAbsent_ClonesItAtThePin_ThenBuildsItFromThatCommit()
    {
        (await Client.PutLoadOrder(_instance, _instance.Plugins)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        using var submodule = new PinnedSubmodule(_instance.Root, Origin);
        AnotherTool.CopyDirectory(Client.SourceFolderSentFor(Origin), submodule.Remote);
        var pin = PinnedSubmodule.Git(submodule.Remote, "rev-parse", "HEAD").Trim();
        submodule.Pin(pin);

        var cloned = await Answer(await Client.PostAsJsonAsync("/clone-submodules", new { submodules = new[] { new { folder = submodule.Folder, pin } } }));
        var built = await Answer(await Client.PostAsJsonAsync("/build", new
        {
            mods = new[]
            {
                new
                {
                    name = Origin, sourceFolder = submodule.Folder, folder = Path.GetDirectoryName(_instance.Plugins.Single().Path).Require(),
                },
            },
            exclusionMark = ".mohidden",
        }));

        Assert.Equal(submodule.Folder, Assert.Single(cloned.GetProperty("applied").EnumerateArray()).GetProperty("folder").GetString());
        Assert.Equal(pin, PinnedSubmodule.Git(submodule.Folder, "rev-parse", "HEAD").Trim());
        Assert.Equal(Origin, Assert.Single(built.GetProperty("applied").EnumerateArray()).GetProperty("mod").GetString());
    }
}
