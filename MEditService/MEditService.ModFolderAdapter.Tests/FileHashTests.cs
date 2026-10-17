namespace MEditService.ModFolderAdapter.Tests;

public sealed class FileHashTests
{
    [Fact]
    public void ThePinOfTheFilesAModTakes_IsAHashOfTheirPathsAndHashesInAlphabeticalOrder_ThisOneIn()
    {
        var pin = FileHash.OfFilesTaken([new HashedFile("meshes/b.nif", "Mr+EvxoNp0I="), new HashedFile("a.dds", "M5WSec/sW34=")]);

        Assert.Equal("U6/ScIuKmyg=", pin);
    }
}
