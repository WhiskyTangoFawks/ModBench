using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

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
    public void AnAbsentSubmodule_IsClonedAtItsPin_SoItsManifestIsThere()
    {
        var pin = _submodule.Commit(("Mod.manifest.json", "{\"output\": \"Mod\", \"files\": []}"));
        _submodule.Pin(pin);

        var answer = TestEditService.CloneSubmodulesHandler().Clone([new Submodule(_submodule.Folder, pin, null)], CancellationToken.None);

        Assert.Equal((new SubmoduleCloned(_submodule.Folder), 0), (Assert.Single(answer.Applied), answer.Refused.Count));
        Assert.Equal(pin, PinnedSubmodule.Git(_submodule.Folder, "rev-parse", "HEAD").Trim());
        Assert.True(File.Exists(Path.Combine(_submodule.Folder, "Mod.manifest.json")));
    }

    [Fact]
    public void ASubmoduleAtAnotherCommitThanItsPin_IsNamedWithTheCommit_AndLeftThere()
    {
        var first = _submodule.Commit(("Mod.manifest.json", "{\"output\": \"Mod\", \"files\": []}"));
        var second = _submodule.Commit(("notes.txt", "later"));
        _submodule.Pin(second);
        TestEditService.CloneSubmodulesHandler().Clone([new Submodule(_submodule.Folder, second, null)], CancellationToken.None);

        var answer = TestEditService.CloneSubmodulesHandler().Clone([new Submodule(_submodule.Folder, first, null)], CancellationToken.None);

        Assert.Equal(
            (new SubmoduleNotCloned(_submodule.Folder, CloneRefusal.AtAnotherCommit, $"its submodule is at {second}, not at {first}, the commit the instance repository pins"), 0),
            (Assert.Single(answer.Refused), answer.Applied.Count));
        Assert.Equal(second, PinnedSubmodule.Git(_submodule.Folder, "rev-parse", "HEAD").Trim());
    }

    [Fact]
    public void ASubmoduleWhosePinItsRemoteLacks_IsNotCloned_NamingWhy()
    {
        _submodule.Commit(("Mod.manifest.json", "{}"));
        const string Unpushed = "0123456789012345678901234567890123456789";
        _submodule.Pin(Unpushed);

        var answer = TestEditService.CloneSubmodulesHandler().Clone([new Submodule(_submodule.Folder, Unpushed, null)], CancellationToken.None);

        Assert.Equal(
            (new SubmoduleNotCloned(_submodule.Folder, CloneRefusal.NotCloned, $"its remote holds no commit {Unpushed}"), 0),
            (Assert.Single(answer.Refused), answer.Applied.Count));
    }
}
