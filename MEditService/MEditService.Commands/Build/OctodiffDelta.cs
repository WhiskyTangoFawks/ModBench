using Octodiff.Core;
using Octodiff.Diagnostics;

namespace MEditService.Commands.Build;

/// <summary>A delta as Wabbajack makes one, so Wabbajack's installer could apply it.</summary>
internal static class OctodiffDelta
{
    public static byte[] Make(Stream basis, Stream file)
    {
        using var signature = new MemoryStream();
        new SignatureBuilder().Build(basis, new SignatureWriter(signature));
        signature.Position = 0;
        using var delta = new MemoryStream();
        new DeltaBuilder().BuildDelta(
            file, new SignatureReader(signature, new NullProgressReporter()), new AggregateCopyOperationsDecorator(new BinaryDeltaWriter(delta)));
        return delta.ToArray();
    }
}
