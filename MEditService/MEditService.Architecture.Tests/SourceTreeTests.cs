using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class SourceTreeTests
{
    [Fact]
    public void Sites_CountsEachNeedlePerFile_AndSkipsBuildOutputButNotACheckoutUnderAFolderNamedBin()
    {
        using var scratch = new ScratchDirectory("medit-source-tree-");
        var checkout = Path.Combine(scratch, "bin", "checkout");
        ScratchFiles.Plant(checkout, "P/Two.cs", "File.Exists(a); File.Delete(a); Directory.Exists(a);");
        ScratchFiles.Plant(checkout, "P/obj/Generated.cs", "File.Exists(a);");
        ScratchFiles.Plant(checkout, "P/bin/Debug/Copied.cs", "File.Exists(a);");
        ScratchFiles.Plant(checkout, "P/Clean.cs", "store.Read();");

        var sites = SourceTree.Sites(
            checkout,
            SourceTree.CSharpFiles(Path.Combine(checkout, "P")),
            [("File.", new Regex(@"File\.")), ("Directory.", new Regex(@"Directory\."))],
            File.ReadAllText);

        Assert.Equal(["P/Two.cs: Directory.: 1", "P/Two.cs: File.: 2"], sites);
    }
}
