using MEditService.Codec.Serialization;

namespace MEditService.Codec.Tests.Serialization;

public class FirstChangedBelowTests
{
    private const string Essential = "Configuration.Flags.Essential";

    [Theory]
    [InlineData("""["512","Essential"]""", """["512"]""", Essential)]
    [InlineData("""["Essential"]""", """["512"]""", Essential)]
    [InlineData("""["512"]""", """["512","Female"]""", null)]
    [InlineData("""["512","Essential"]""", """["512","Essential","Female"]""", null)]
    [InlineData("""["512"]""", """["513"]""", Essential)]
    public void AFlagsWrite_ChangesATemplatedBit_OnlyWhereTheBitOrANumberTheMemberLacksChanges(string held, string requested, string? changed)
    {
        var record = Document.Parse("{\"Configuration\":{\"Flags\":" + held + "}}");

        Assert.Equal(changed, record.FirstChangedBelow([Essential], requested, "Configuration", "Flags"));
    }
}
