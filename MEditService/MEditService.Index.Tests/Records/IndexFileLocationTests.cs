using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Records;

// ADR-0009: one index file per MO2 instance, inside the instance root. `origin` is a mod folder
// name unique only within an instance and every row is keyed (plugin, origin), so the instance is
// the only honest scope.
public sealed class IndexFileLocationTests : IDisposable
{
    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("index-file").WithPlugin("A.esp").Build();

    public void Dispose() => _fixture.Dispose();

    private string Instance(string name) => Directory.CreateDirectory(Path.Combine(_fixture.InstanceRoot, name)).FullName;

    // The instance root is MO2's working directory, but `mods/`, `overwrite/`, `profiles/` and
    // `downloads/` are content it manages: a reinstall, a profile delete or a download sweep would
    // take an index under any of them with it.
    [Fact]
    public void TheIndexFile_LivesInTheInstanceRoot_BesideTheContentMO2Manages_NeverInsideIt()
    {
        var instance = Instance("instance");
        foreach (var managed in new[] { "mods", "overwrite", "profiles", "downloads" })
            Directory.CreateDirectory(Path.Combine(instance, managed));

        using (var index = Indexes.Reconciled(_fixture, instance)) { }

        Assert.Equal(Path.Combine(instance, "modbench", "index.duckdb"), IndexFiles.In(instance));
    }

    // Profiles within one instance share the file — that is what keeps a profile switch cheap — so
    // trailing separators and relative segments must not mint a second file for one instance.
    [Fact]
    public void TheSameInstanceSpeltDifferently_FindsTheOneFile()
    {
        var instance = Instance("instance-spelling");
        Directory.CreateDirectory(Path.Combine(instance, "mods"));
        var spelledOtherwise = Path.Combine(instance, "mods", "..") + Path.DirectorySeparatorChar;
        using (var cold = Indexes.Reconciled(_fixture, instance)) { }

        using var opens = new GatedPluginAdapter();
        using var warm = Indexes.Reconciled(_fixture, spelledOtherwise, opens);

        Assert.Equal(0, opens.OpenedTotal);
        Assert.Single(Directory.GetFiles(instance, "*.duckdb", SearchOption.AllDirectories));
    }

    // Two instances on one game have their own same-named mod folders holding different bytes, so
    // they must never share a store.
    [Fact]
    public void ADifferentInstance_GetsItsOwnFile()
    {
        var a = Instance("instance-a");
        var b = Instance("instance-b");

        using (var first = Indexes.Reconciled(_fixture, a)) { }
        using (var second = Indexes.Reconciled(_fixture, b)) { }

        Assert.NotEqual(IndexFiles.In(a), IndexFiles.In(b));
    }
}
