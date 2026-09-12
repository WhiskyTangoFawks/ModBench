using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>The mod folder's meta facts as the repository answers them (ADR-0003): what Track's
/// baseline trailers and the external-change classifier read, without either reading the file.</summary>
public sealed class SourceRepositoryMetaFactsTests
{
    // sha256sum of the two fixture bytes below, not a recomputation of the production expression.
    private const string Sha256OfVersion123 =
        "686A4071A5812CF47F98DCDBAB7DA550299F92CD8C452867F77E44DE1C7513E9";

    [Fact]
    public void MetaFactsIn_AnswersTheVersionAndTheFilesOwnHash()
    {
        using var mod = new ScratchFolder();
        File.WriteAllText(Path.Combine(mod.Path, "meta.ini"), "version=1.2.3\n");

        var facts = SourceRepository.MetaFactsIn(mod.Path);

        Assert.Equal("1.2.3", facts.UpstreamVersion);
        Assert.Equal(Sha256OfVersion123, facts.MetaSha256);
    }

    // An authored or manually-installed mod routinely has neither file nor line.
    [Fact]
    public void MetaFactsIn_AnswersNothing_ForAModFolderWithNoMetaIni()
    {
        using var mod = new ScratchFolder();

        var facts = SourceRepository.MetaFactsIn(mod.Path);

        Assert.Null(facts.UpstreamVersion);
        Assert.Null(facts.MetaSha256);
    }

    [Fact]
    public void MetaFactsIn_AnswersNoVersion_ForAMetaIniDeclaringNone()
    {
        using var mod = new ScratchFolder();
        File.WriteAllText(Path.Combine(mod.Path, "meta.ini"), "[General]\ninstallationFile=x.7z\n");

        var facts = SourceRepository.MetaFactsIn(mod.Path);

        Assert.Null(facts.UpstreamVersion);
        Assert.NotNull(facts.MetaSha256);
    }

    private sealed class ScratchFolder : IDisposable
    {
        internal string Path { get; } = Directory.CreateTempSubdirectory("medit-metafacts-").FullName;

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
