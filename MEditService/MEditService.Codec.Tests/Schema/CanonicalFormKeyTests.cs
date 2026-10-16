using MEditService.Codec.Schema;

namespace MEditService.Codec.Tests.Schema;

public class CanonicalFormKeyTests
{
    [Theory]
    [InlineData("000800:Master.esm", "000800:Master.esm")]
    [InlineData("000800_Master.esm", "000800:Master.esm")]
    [InlineData("00080a:Master.esm", "00080A:Master.esm")]
    [InlineData("garbage", null)]
    [InlineData("000800:Master", null)]
    public void AFormKey_HasOneSpelling_TheOneMutagensParseWritesBack(string text, string? canonical)
    {
        Assert.Equal(canonical, CanonicalFormKey.Of(text));
    }
}
