const albumImage = "/scrollstory/placeholder-album.svg";
const artistImage = "/scrollstory/placeholder-person.svg";

export const yearOrder = Array.from({ length: 15 }, (_, index) => 2011 + index);

export const ageBinOrder = [
  "18-24",
  "25-29",
  "30-34",
  "35-39",
  "40-44",
  "45-49",
  "50-54",
  "55-59",
  "60+"
];

const albumsPerYear = {
  2010: 8,
  2011: 9,
  2012: 10,
  2013: 11,
  2014: 10,
  2015: 12,
  2016: 11,
  2017: 13,
  2018: 12,
  2019: 13,
  2020: 9,
  2021: 10,
  2022: 12,
  2023: 14,
  2024: 13,
  2025: 8
};

const artistNames = [
  "Aster Vale",
  "Blue Hour",
  "Civic Choir",
  "Dawn Ledger",
  "Echo North",
  "Fable Drive",
  "Glass Atlas",
  "Honey Static",
  "Iris Lo",
  "Juniper Lane",
  "Kite Signal",
  "Lunar Field",
  "Mika Stone",
  "Nova Parks",
  "Orbit Club",
  "Pale Cinema",
  "Quartz Lake",
  "River Tone",
  "Solar Twin",
  "Tessellate"
];

function pad(number) {
  return String(number).padStart(3, "0");
}

function ageBinFor(age) {
  if (age >= 60) return "60+";
  if (age < 25) return "18-24";
  const start = Math.floor(age / 5) * 5;
  return `${start}-${start + 4}`;
}

export const mockAlbums = yearOrder.flatMap((year, yearIndex) => {
  const count = albumsPerYear[year];

  return Array.from({ length: count }, (_, index) => {
    const serial = yearOrder.slice(0, yearIndex).reduce((sum, item) => sum + albumsPerYear[item], 0) + index + 1;
    const artistIndex = (yearIndex * 5 + index * 3) % artistNames.length;
    const artistAge = 18 + ((yearIndex * 4 + index * 7) % 49);

    return {
      id: `album_${pad(serial)}`,
      title: `Music Map Album ${pad(serial)}`,
      year,
      artist: artistNames[artistIndex],
      artistId: `artist_${pad(artistIndex + 1)}`,
      artistAge,
      ageBin: ageBinFor(artistAge),
      image: albumImage
    };
  });
});

export const mockArtistMoments = mockAlbums.map((album) => ({
  id: `artist_moment_${album.id}`,
  albumId: album.id,
  name: album.artist,
  year: album.year,
  artistAge: album.artistAge,
  ageBin: album.ageBin,
  image: artistImage
}));
