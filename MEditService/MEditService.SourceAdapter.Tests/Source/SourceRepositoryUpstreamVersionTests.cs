namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>The upstream version as the repository answers it from the mod folder's
/// <c>meta.ini</c>, which Track's baseline trailers record.</summary>
public sealed class SourceRepositoryUpstreamVersionTests
{
    [Fact]
    public void UpstreamVersionIn_AnswersTheVersion()
    {
        using var mod = new ScratchFolder();
        File.WriteAllText(Path.Combine(mod.Path, "meta.ini"), "version=1.2.3\n");

        Assert.Equal("1.2.3", SourceRepository.UpstreamVersionIn(mod.Path));
    }

    // An authored or manually-installed mod routinely has neither file nor line.
    [Fact]
    public void UpstreamVersionIn_AnswersNothing_ForAModFolderWithNoMetaIni()
    {
        using var mod = new ScratchFolder();

        Assert.Null(SourceRepository.UpstreamVersionIn(mod.Path));
    }

    [Fact]
    public void UpstreamVersionIn_AnswersNothing_ForAMetaIniDeclaringNone()
    {
        using var mod = new ScratchFolder();
        File.WriteAllText(Path.Combine(mod.Path, "meta.ini"), "[General]\ninstallationFile=x.7z\n");

        Assert.Null(SourceRepository.UpstreamVersionIn(mod.Path));
    }

    private sealed class ScratchFolder : IDisposable
    {
        internal string Path { get; } = Directory.CreateTempSubdirectory("medit-metafacts-").FullName;

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
