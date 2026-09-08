using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>"Does this plugin's tree hold that FormKey at either ref" — the collision check every
/// allocation runs. Its working-tree arm answers the same questions the identity read does: the
/// header, and any spelling that parses.</summary>
public sealed class SourceRepositoryHoldsAtEitherRefTests
{
    [Fact]
    public void AnUncommittedHeaderDocument_IsHeld_ThoughNoRefButTheWorkingTreeCarriesIt()
    {
        using var mod = SourceEditFixture.Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(SourceEditFixture.PluginName));
        var headerPath = Path.Combine(
            SourceRepository.RootFor(SourceEditFixture.PluginName), SourceRepository.RecordDataFileName);

        // The shape a plugin minted since the last commit has: its header document is on disk and at
        // no ref at all.
        var gitDir = Path.Combine(mod.ModFolder, ".git");
        GitCli.Run(gitDir, mod.ModFolder, "rm", "--cached", "-q", "--", SourceRepository.ToGitPath(headerPath));
        GitCli.Run(gitDir, mod.ModFolder, "commit", "-q", "-m", "uncommit the header");

        var repository = SourceRepository.Open(mod.ModFolder, GameRelease.Fallout4)!;
        Assert.DoesNotContain(repository.ReadAll(mod.Plugin, "HEAD"), d => d.FormKey == headerFormKey);
        Assert.True(repository.HoldsAtEitherRef(mod.Plugin, headerFormKey));
    }

    [Fact]
    public void AnUncommittedEmbeddedChild_IsHeld_UnderAnyFormKeySpellingThatParses()
    {
        using var fixture = new SourceContainerFixture();
        const string renumbered = "00080A:SourceContainer.esp";

        // Renumbered rather than seeded: at HEAD the child still sits under its old key, so only the
        // working tree can answer, and only through the document that inlines it.
        var result = fixture.Edits.RenumberRecord(fixture.Plugin, fixture.TopCellRef.ToString(), renumbered);
        Assert.True(result.Applied, result.Message);

        var repository = SourceRepository.Open(fixture.ModFolder, GameRelease.Fallout4)!;
        Assert.True(repository.HoldsAtEitherRef(fixture.Plugin, renumbered));
        Assert.True(repository.HoldsAtEitherRef(fixture.Plugin, "00080a:SourceContainer.esp"));
    }
}
