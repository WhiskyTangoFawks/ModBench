using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Source;

public sealed class DeletedReferenceDecompileTests : IDisposable
{
    private const string ModName = "FixtureMod";

    private readonly ScratchDirectory _root = new("medit-deleted-reference-decompile-");
    private readonly string _modFolder;
    private readonly LoadOrderHolder _holder = new();

    public DeletedReferenceDecompileTests()
    {
        _modFolder = Directory.CreateDirectory(Path.Combine(_root, "mods", ModName)).FullName;
        var dataFolder = Directory.CreateDirectory(Path.Combine(_root, "Data")).FullName;
        var pluginPath = Path.Combine(_modFolder, "Fixture.esp");
        File.WriteAllBytes(pluginPath, DeletedReferencePlugin.Bytes("Fixture.esp"));
        _holder.Apply(SnapshotPlugins.Snapshot(dataFolder, _root, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", pluginPath, ModName, 0, Enabled: true, Winning: true)]));
        TestEditService.VersionInGitHandler(_holder)
            .VersionInGitAsync(ToVersionInGit.In(_holder.Held?.Snapshot, ModName)).GetAwaiter().GetResult().Value();
    }

    public void Dispose() => _root.Dispose();

    private static PluginAddress Fixture => new("Fixture.esp", ModName);

    [Fact]
    public void ADeletedReferenceHoldingItsBaseRecord_IsInitedAsItsHeaderAlone()
    {
        var text = SourceText();

        Assert.Contains("HarborCell", text, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Base\"", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ThePluginCompiledFromThatSource_DecompilesToTheSameSource()
    {
        var before = SourceText();
        Assert.Single((await TestEditService.CompileHandler(_holder).CompileAsync([Fixture])).Value().Applied);

        var decompiled = (await TestEditService.DecompileHandler(_holder).DecompileAsync([Fixture], force: true)).Value();

        Assert.Equal([Fixture], decompiled.Applied);
        Assert.Equal(before, SourceText());
    }

    private string SourceText()
    {
        var repository = TestAdapters.Source().Open(new PluginProvider.FromMod(ModName, _modFolder, _modFolder), GameRelease.Fallout4).Require();
        return string.Concat(TreeDocuments.Of(repository, Fixture).Select(document => document.Body).Order(StringComparer.Ordinal));
    }
}
