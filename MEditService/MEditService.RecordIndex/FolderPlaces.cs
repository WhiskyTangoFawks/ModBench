namespace MEditService.RecordIndex;

internal static class FolderPlaces
{
    /// <summary>A place inside <paramref name="folder"/> spelled relative to it, any other place as given.</summary>
    internal static string RelativeWithin(string folder, string place) =>
        Path.GetRelativePath(folder, place) is var relative && !relative.StartsWith("..", StringComparison.Ordinal) && !Path.IsPathRooted(relative)
            ? relative
            : place;
}
